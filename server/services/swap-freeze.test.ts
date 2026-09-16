/**
 * THE DECISION: WHO GETS FROZEN, WHEN, AND WHAT MUST NEVER BE SIGNALLED.
 *
 * Every dependency is injected - the process table, the footprints, the clock,
 * the verdicts, the ledger and the signals - because the thing under test is a
 * decision whose mistakes are not exceptions but stopped processes: the server
 * in its own group, a CLI mid-stream, an MCP server that hangs every tool call.
 * The recorder here refuses a signal the same way production does, and the
 * property test at the end throws 200 random trees and group layouts at it.
 *
 * @covers KANBAN-85
 */
import { describe, expect, test } from "bun:test";
import { createSwapFreezer, pickVictim, thawReason, type FreezeCandidate } from "./swap-freeze";
import { createSwapFreezeLedger, type LedgerIo } from "./swap-freeze-ledger";
import type { AgentSessionRef, NativeCommandRef, PsRow } from "../lib/agent-tool-children";
import type { HeldMemory, SwapVerdict } from "./mem-signal";
import { FREEZE_MAX_MS } from "../../shared/swap-freeze";

const T0 = 1_760_000_000_000;

const SERVER = 1733;
const CLI = 38515;
const BRIDGE = 2382;

interface ProcSpec {
  pid: number;
  ppid: number;
  pgid?: number;
  command: string;
  /** Core-units this process burns, turned into CPU seconds as the clock moves. */
  cores?: number;
  footprintGB?: number;
  residentGB?: number;
}

const BASE: ProcSpec[] = [
  { pid: 1, ppid: 0, pgid: 0, command: "/sbin/launchd" },
  { pid: 981, ppid: 1, pgid: 981, command: "bash scripts/start-prod.sh" },
  { pid: SERVER, ppid: 981, pgid: 981, command: "bun run server.ts" },
  { pid: 10557, ppid: 981, pgid: 981, command: "fswatch -o server" },
  { pid: BRIDGE, ppid: 1, pgid: BRIDGE, command: "pty-bridge --socket /tmp/topics-pty-bridge.sock" },
  { pid: CLI, ppid: 34260, pgid: 48914, command: "/Applications/claude.app/Contents/MacOS/claude --resume=abc" },
  { pid: 39135, ppid: CLI, pgid: 48914, command: "bun run topics-mcp-server.ts" },
];

/** A background shell of the CLI: its own group, the recorded command in its `eval`. */
function shell(pid: number, command: string, opts: { cores?: number; footprintGB?: number; residentGB?: number } = {}): ProcSpec[] {
  return [
    { pid, ppid: CLI, pgid: pid, command: `/bin/zsh -c source ~/.claude/shell-snapshots/snapshot-zsh-1.sh && eval '${command}' < /dev/null && pwd -P` },
    { pid: pid + 4, ppid: pid, pgid: pid, command, cores: opts.cores ?? 0, footprintGB: opts.footprintGB ?? 0, residentGB: opts.residentGB ?? 0 },
  ];
}

interface World {
  freezer: ReturnType<typeof createSwapFreezer>;
  signals: { pid: number; sig: string }[];
  logs: string[];
  now: () => number;
  advance(ms: number): void;
  beat(over?: { sustained?: boolean; heldGB?: number | null; pagesReadBackPerS?: number | null; brake?: { interrupted: boolean; skipped: string | null } }): Promise<void>;
  ledgerText(): string | null;
  setProcs(list: ProcSpec[]): void;
  stopped: Set<number>;
}

function world(i: {
  procs: ProcSpec[];
  sessions?: AgentSessionRef[];
  natives?: NativeCommandRef[];
  ledgerText?: string | null;
  /** A pid the post-check reports as stopped even though it was never signalled. */
  fakeStopped?: number[];
  outsidePeers?: (pids: readonly number[]) => Promise<number[]>;
  xpc?: Record<number, number[]>;
  xpcFootprintGB?: number;
}): World {
  let procs = [...i.procs];
  let clock = T0;
  const signals: { pid: number; sig: string }[] = [];
  const logs: string[] = [];
  const stopped = new Set<number>();
  let text = i.ledgerText ?? null;
  const io: LedgerIo = { read: () => text, write: (t) => { text = t; }, log: (l) => logs.push(l) };
  const ledger = createSwapFreezeLedger(io);
  const spec = (pid: number): ProcSpec | undefined => procs.find((p) => p.pid === pid);

  const table = (): PsRow[] => procs.map((p) => ({
    pid: p.pid, ppid: p.ppid, pgid: p.pgid ?? p.pid,
    cpuSeconds: (p.cores ?? 0) * ((clock - T0) / 1000),
    command: p.command,
  }));

  const freezer = createSwapFreezer({
    now: () => clock,
    processTable: async () => table(),
    footprintKB: (pid) => {
      const own = spec(pid)?.footprintGB ?? 0;
      const asXpc = Object.values(i.xpc ?? {}).some((list) => list.includes(pid)) ? (i.xpcFootprintGB ?? 0) : 0;
      return ((own + asXpc) * 1e9) / 1024;
    },
    residentKB: (pid) => ((spec(pid)?.residentGB ?? 0) * 1e9) / 1024,
    lstartOf: async (pids) => new Map(pids.filter((p) => spec(p) || (i.xpc && Object.values(i.xpc).flat().includes(p))).map((p) => [p, `start-${p}`])),
    statOf: async (pids) => new Map(pids.map((p) => [p, stopped.has(p) || (i.fakeStopped ?? []).includes(p) ? "T" : "S"])),
    signal: (pid, sig) => {
      // The production invariant, asserted from the outside: a SIGSTOP to a pid
      // the ledger does not name yet is a defect, not a test failure to tune.
      if (sig === "SIGSTOP") {
        const onDisk = JSON.parse(text ?? "{}") as { active?: { batches: { groups: { pgid: number }[]; pids: { pid: number }[] }[] }[] };
        const named = (onDisk.active ?? []).flatMap((t) => t.batches.flatMap((b) => [...b.pids.map((p) => p.pid), ...b.groups.map((g) => g.pgid)]));
        if (!named.includes(Math.abs(pid))) throw new Error(`SIGSTOP to ${pid} before it was on disk`);
      }
      signals.push({ pid, sig });
      const members = pid < 0 ? procs.filter((p) => (p.pgid ?? p.pid) === -pid).map((p) => p.pid) : [pid];
      for (const m of members) { if (sig === "SIGSTOP") stopped.add(m); else stopped.delete(m); }
    },
    sessions: () => i.sessions ?? [],
    natives: () => i.natives ?? [],
    guardRoles: () => ({ serverPid: SERVER, sidecarPids: [BRIDGE], cliPids: [CLI] }),
    xpcServicePids: async (appPid) => (i.xpc ?? {})[appPid] ?? [],
    outsidePeers: i.outsidePeers ?? (async () => []),
    ledger,
    log: (line) => logs.push(line),
  });

  return {
    freezer, signals, logs, stopped,
    now: () => clock,
    advance: (ms) => { clock += ms; },
    ledgerText: () => text,
    setProcs: (list) => { procs = [...list]; },
    async beat(over = {}) {
      const swap: SwapVerdict = {
        sustained: over.sustained ?? true,
        pagesReadBackPerS: over.pagesReadBackPerS ?? 33.6,
        debtGBPerMin: 8.8,
        coveredMs: 120_000,
      };
      const held: HeldMemory = { measurable: true, latestGB: 4, heldGB: over.heldGB ?? 4, coveredMs: 120_000 };
      await freezer.tick({ swap, held, brake: over.brake ?? { interrupted: false, skipped: "noHeavyRun" } });
    },
  };
}

const session = (over: Partial<AgentSessionRef> = {}): AgentSessionRef => ({
  sessionKey: "topic:a", cliPid: CLI, topicId: "a", terminalId: "term-a", taskId: null,
  backgroundBash: [], foregroundBash: null, ...over,
});

/** Two beats: the first has no CPU base, so a rate is measured and not invented. */
async function twoBeats(w: World, over?: Parameters<World["beat"]>[0]): Promise<void> {
  await w.beat(over);
  w.advance(10_000);
  await w.beat(over);
}

describe("F5: the heaviest background command, and nothing else", () => {
  const procs = [
    ...BASE,
    ...shell(51000, "bun batteria.ts", { cores: 0.5, footprintGB: 2.1, residentGB: 1.4 }),
    ...shell(52000, "bun idle-hog.ts", { cores: 0, footprintGB: 3.0, residentGB: 2.0 }),
    ...shell(53000, "bun tiny.ts", { cores: 0.9, footprintGB: 0.4, residentGB: 0.3 }),
    ...shell(54000, "bun barra.ts && bun prova-3d.ts", { cores: 0.8, footprintGB: 2.6, residentGB: 2.0 }),
  ];
  const sessions = [session({
    backgroundBash: [
      { command: "bun batteria.ts", startedAt: T0 },
      { command: "bun idle-hog.ts", startedAt: T0 },
      { command: "bun tiny.ts", startedAt: T0 },
    ],
    foregroundBash: "bun barra.ts && bun prova-3d.ts",
  })];

  test("A (2.1 GB, 0.5 core) is frozen; the idle 3 GB, the small one and the foreground are not", async () => {
    const w = world({ procs, sessions });
    await twoBeats(w);
    const stopped = w.signals.filter((s) => s.sig === "SIGSTOP").map((s) => Math.abs(s.pid));
    expect(stopped).toContain(51000);
    for (const other of [52000, 52004, 53000, 53004, 54000, 54004]) expect(stopped).not.toContain(other);
    expect(w.freezer.views()).toHaveLength(1);
    expect(w.freezer.views()[0]!.command).toBe("bun batteria.ts");
  });

  test("the foreground command is named in the log, so nobody has to guess why", async () => {
    const w = world({ procs, sessions });
    await twoBeats(w);
    expect(w.logs.join("\n")).toContain("foreground Bash, never frozen");
  });

  test("an idle heavyweight alone freezes nothing, and the line says what was missing", async () => {
    const w = world({ procs: [...BASE, ...shell(52000, "bun idle-hog.ts", { cores: 0, footprintGB: 3.0 })], sessions: [session({ backgroundBash: [{ command: "bun idle-hog.ts", startedAt: T0 }] })] });
    await twoBeats(w);
    expect(w.signals).toEqual([]);
    expect(w.logs.join("\n")).toContain("nothing to freeze");
  });

  test("the pure rule on its own: floor, CPU, ties and the two-freeze limit", () => {
    const c = (over: Partial<FreezeCandidate>): FreezeCandidate => ({
      root: { kind: "claude-background", pid: 1, pgid: 1, sessionKey: "s", command: "x", topicId: null, terminalId: null, taskId: null },
      treePids: [1], xpcPids: [], footprintGB: 1, residentGB: 1, cpuCores: 1, frozenCount: 0, ...over,
    });
    expect(pickVictim([c({ footprintGB: 0.49 })]).skipped).toBe("belowFloor");
    expect(pickVictim([c({ cpuCores: 0.05 })]).skipped).toBe("belowFloor");
    expect(pickVictim([c({ frozenCount: 2 })]).skipped).toBe("exhausted");
    const heavy = c({ footprintGB: 2, cpuCores: 0.2 });
    const withMoreCpu = c({ footprintGB: 2, cpuCores: 0.9 });
    expect(pickVictim([heavy, withMoreCpu]).victim).toBe(withMoreCpu);
  });
});

describe("F6: what a freeze must never reach", () => {
  test("a session nobody declared has no roots at all: a human shell pane is never enumerated", async () => {
    const w = world({ procs: [...BASE, ...shell(51000, "vim", { cores: 1, footprintGB: 3 })], sessions: [] });
    await twoBeats(w);
    expect(w.signals).toEqual([]);
  });

  test("a tree with an established peer outside itself is skipped for the next heaviest", async () => {
    const procs = [
      ...BASE,
      ...shell(51000, "bun run dev", { cores: 0.6, footprintGB: 3.0 }),
      ...shell(52000, "bun batteria.ts", { cores: 0.5, footprintGB: 2.1 }),
    ];
    const sessions = [session({ backgroundBash: [{ command: "bun run dev", startedAt: T0 }, { command: "bun batteria.ts", startedAt: T0 }] })];
    const w = world({
      procs, sessions,
      // The dev server has a browser of the owner attached; the battery has not.
      outsidePeers: async (pids) => (pids.includes(51000) ? [777] : []),
    });
    await twoBeats(w);
    const stopped = w.signals.filter((s) => s.sig === "SIGSTOP").map((s) => Math.abs(s.pid));
    expect(stopped).toContain(52000);
    expect(stopped).not.toContain(51000);
    expect(w.logs.join("\n")).toContain("established peer(s) outside its tree");
  });

  test("property: over 200 random layouts, no guarded pid and no guarded group is ever signalled", async () => {
    let seed = 7;
    const pick = (n: number): number => { seed = (seed * 1103515245 + 12345) % 2147483647; return seed % n; };
    for (let round = 0; round < 200; round++) {
      const procs: ProcSpec[] = [...BASE];
      const roots: string[] = [];
      const count = 1 + pick(3);
      for (let k = 0; k < count; k++) {
        const pid = 51000 + k * 1000;
        const cmd = `bun work-${k}.ts`;
        roots.push(cmd);
        procs.push(...shell(pid, cmd, { cores: 0.2 + pick(9) / 10, footprintGB: 0.4 + pick(30) / 10 }));
        // Some grandchildren land in their own group, some share the shell's.
        procs.push({ pid: pid + 10, ppid: pid + 4, pgid: pick(2) === 0 ? pid : pid + 10, command: `child of ${cmd}`, cores: pick(5) / 10, footprintGB: pick(20) / 10 });
      }
      const w = world({ procs, sessions: [session({ backgroundBash: roots.map((command) => ({ command, startedAt: T0 })) })] });
      await twoBeats(w);
      const guarded = [1, 981, SERVER, 10557, BRIDGE, CLI, 39135];
      for (const s of w.signals) {
        const members = s.pid < 0 ? procs.filter((p) => (p.pgid ?? p.pid) === -s.pid).map((p) => p.pid) : [s.pid];
        for (const m of members) expect(guarded, `round ${round} signalled ${m}`).not.toContain(m);
      }
    }
  });
});

describe("F7: the brake goes first, and the two levers share one window", () => {
  const procs = [...BASE, ...shell(51000, "bun batteria.ts", { cores: 0.5, footprintGB: 2.1 })];
  const sessions = [session({ backgroundBash: [{ command: "bun batteria.ts", startedAt: T0 }] })];

  test("nothing is frozen on a beat the brake acted on", async () => {
    const w = world({ procs, sessions });
    await twoBeats(w, { brake: { interrupted: true, skipped: null } });
    expect(w.signals).toEqual([]);
  });

  test("nor while the brake is merely spacing itself", async () => {
    const w = world({ procs, sessions });
    await twoBeats(w, { brake: { interrupted: false, skipped: "spacing" } });
    expect(w.signals).toEqual([]);
  });

  test("a freeze closes the window for 120 s, and `lastActionAt` is what the brake reads", async () => {
    const w = world({
      procs: [...procs, ...shell(52000, "bun altro.ts", { cores: 0.5, footprintGB: 2.5 })],
      sessions: [session({ backgroundBash: [{ command: "bun batteria.ts", startedAt: T0 }, { command: "bun altro.ts", startedAt: T0 }] })],
    });
    await twoBeats(w);
    const after = w.signals.length;
    expect(after).toBeGreaterThan(0);
    expect(w.freezer.lastActionAt()).toBe(w.now());
    w.advance(30_000);
    await w.beat();
    expect(w.signals.length, "a second freeze inside the window").toBe(after);
    w.advance(100_000);
    await w.beat();
    expect(w.signals.length).toBeGreaterThan(after);
  });
});

describe("F8 and F9: what continues a tree, and what does not", () => {
  const procs = [...BASE, ...shell(51000, "bun batteria.ts", { cores: 0.5, footprintGB: 2.1, residentGB: 1.4 })];
  const sessions = [session({ backgroundBash: [{ command: "bun batteria.ts", startedAt: T0 }] })];

  test("F8: calm alone does not thaw", async () => {
    const w = world({ procs, sessions });
    await twoBeats(w);
    expect(w.freezer.views()).toHaveLength(1);
    w.advance(60_000);
    await w.beat({ sustained: false, heldGB: 5.5 });
    expect(w.freezer.views(), "calm is what the freeze produced, not a reason to undo it").toHaveLength(1);
  });

  test("F9: room, at the floor plus what the tree would take back", async () => {
    const w = world({ procs, sessions });
    await twoBeats(w);
    w.advance(60_000);
    await w.beat({ sustained: false, heldGB: 7.5 });
    expect(w.freezer.views()).toHaveLength(0);
    expect(w.logs.join("\n")).toContain("thawed \"bun batteria.ts\"");
    expect(w.logs.join("\n")).toContain("room");
  });

  test("F9: no effect, when the thrash was somebody else's", async () => {
    const w = world({ procs, sessions });
    await twoBeats(w, { pagesReadBackPerS: 30.1 });
    w.advance(150_000);
    await w.beat({ pagesReadBackPerS: 28.7 });
    expect(w.freezer.views()).toHaveLength(0);
    expect(w.logs.join("\n")).toContain("no effect");
  });

  test("F9: ten minutes, whatever the machine is doing", async () => {
    const w = world({ procs, sessions });
    await twoBeats(w, { pagesReadBackPerS: 33.6 });
    // The effect was there, so the no-effect rule does not fire.
    w.advance(150_000);
    await w.beat({ pagesReadBackPerS: 4.1 });
    expect(w.freezer.views()).toHaveLength(1);
    w.advance(FREEZE_MAX_MS);
    await w.beat({ pagesReadBackPerS: 4.1 });
    expect(w.freezer.views()).toHaveLength(0);
    expect(w.logs.join("\n")).toContain(": max");
  });

  test("F9: the owner gone continues every recorded pid", async () => {
    const w = world({ procs, sessions });
    await twoBeats(w);
    await w.freezer.release("topic:a");
    const resumed = w.signals.filter((s) => s.sig === "SIGCONT").map((s) => s.pid);
    // Every recorded pid, not only the group: the leader may be gone by then,
    // and an orphaned member would sleep STOPped under launchd forever.
    expect(resumed).toContain(-51000);
    for (const pid of [51000, 51004]) expect(resumed).toContain(pid);
    expect(w.freezer.views()).toHaveLength(0);
  });

  test("the pure rule, in the order it is asked", () => {
    const base = {
      now: T0 + 60_000, frozenAt: T0, ownerGone: false, sustained: true, heldGB: 12,
      residentGBAtFreeze: 1.4, pagesReadBackPerS: 30, pagesReadBackAtFreeze: 33, effectAlreadyRead: false,
    };
    expect(thawReason({ ...base, ownerGone: true })).toBe("owner gone");
    expect(thawReason({ ...base, sustained: false, heldGB: 7.5 })).toBe("room");
    expect(thawReason({ ...base, sustained: false, heldGB: 7.0 }), "6 GB floor plus the 1.4 the tree takes back").toBeNull();
    expect(thawReason({ ...base, now: T0 + 130_000 })).toBe("no effect");
    expect(thawReason({ ...base, now: T0 + 130_000, effectAlreadyRead: true })).toBeNull();
    expect(thawReason({ ...base, now: T0 + FREEZE_MAX_MS })).toBe("max");
    expect(thawReason(base)).toBeNull();
  });
});

describe("F10: two per tree, across a reload of the server", () => {
  test("the third sustained episode leaves the tree alone and says so", async () => {
    const procs = [...BASE, ...shell(51000, "bun batteria.ts", { cores: 0.5, footprintGB: 2.1, residentGB: 1.4 })];
    const sessions = [session({ backgroundBash: [{ command: "bun batteria.ts", startedAt: T0 }] })];
    const first = world({ procs, sessions });
    await twoBeats(first);
    expect(first.freezer.views()[0]!.n).toBe(1);
    first.advance(60_000);
    await first.beat({ sustained: false, heldGB: 9 });
    expect(first.freezer.views()).toHaveLength(0);

    // A reload: same ledger file, a new freezer with no memory of its own.
    const second = world({ procs, sessions, ledgerText: first.ledgerText() });
    expect(JSON.parse(second.ledgerText()!).active, "nothing is left stopped across the reload").toEqual([]);
    await twoBeats(second);
    expect(second.freezer.views()[0]!.n, "the count survived the reload").toBe(2);
    second.advance(60_000);
    await second.beat({ sustained: false, heldGB: 9 });

    const third = world({ procs, sessions, ledgerText: second.ledgerText() });
    await twoBeats(third);
    expect(third.freezer.views()).toHaveLength(0);
    expect(third.logs.join("\n")).toContain("it runs to the end");
  });
});

describe("F11: the order of the signals, and its exact reverse", () => {
  test("root first, XPC last; the thaw undoes it leaves-first", async () => {
    const procs = [
      ...BASE,
      ...shell(51000, "bun batteria.ts", { cores: 0.5, footprintGB: 2.1, residentGB: 1.4 }),
      { pid: 51010, ppid: 51004, pgid: 51000, command: "/x/Playwright.app/Contents/MacOS/Playwright --headless" },
    ];
    const w = world({
      procs,
      sessions: [session({ backgroundBash: [{ command: "bun batteria.ts", startedAt: T0 }] })],
      xpc: { 51010: [51101, 51102] },
      xpcFootprintGB: 0.2,
    });
    await twoBeats(w);
    const stops = w.signals.filter((s) => s.sig === "SIGSTOP").map((s) => s.pid);
    expect(stops[0], "the root's group goes first: the driver stops issuing work").toBe(-51000);
    expect(stops.slice(-2).sort()).toEqual([51101, 51102]);
    const before = w.signals.length;
    await w.freezer.thawAll("shutdown");
    const resumed = w.signals.slice(before).map((s) => s.pid);
    expect(resumed.slice(0, 2).sort(), "the XPC services are continued first").toEqual([51101, 51102]);
    expect(resumed[resumed.length - 1]).toBe(-51000);
  });

  test("a child forked between the two walks is recorded and stopped by the second batch", async () => {
    const procs = [...BASE, ...shell(51000, "bun batteria.ts", { cores: 0.5, footprintGB: 2.1 })];
    const w = world({ procs, sessions: [session({ backgroundBash: [{ command: "bun batteria.ts", startedAt: T0 }] })] });
    await w.beat();
    w.advance(10_000);
    // The fork happens between the measuring walk and the signalling one.
    w.setProcs([...procs, { pid: 51099, ppid: 51004, pgid: 51099, command: "vite build", cores: 0.2, footprintGB: 0.3 }]);
    await w.beat();
    const stops = w.signals.filter((s) => s.sig === "SIGSTOP").map((s) => Math.abs(s.pid));
    expect(stops).toContain(51099);
  });
});

describe("F12: the guards, and what happens when one trips", () => {
  test("a native tree is signalled pid by pid, and the server is never touched", async () => {
    const procs = [
      ...BASE,
      { pid: 60123, ppid: SERVER, pgid: 981, command: "/bin/bash -lc bun run test:unit", cores: 0.9, footprintGB: 2.4, residentGB: 1.8 },
      { pid: 60130, ppid: 60123, pgid: 981, command: "bun test", cores: 0.9, footprintGB: 1.0, residentGB: 0.8 },
    ];
    const natives: NativeCommandRef[] = [{ sessionKey: "topic:n", pid: 60123, command: "bun run test:unit", topicId: "n", terminalId: null, taskId: null }];
    // The guard keeps the server's group, and the native tree inside it is the
    // one exception - which is exactly why it gets no GROUP signal below.
    const w = world({ procs, natives });
    await twoBeats(w);
    const stops = w.signals.filter((s) => s.sig === "SIGSTOP");
    expect(stops.length).toBeGreaterThan(0);
    for (const s of stops) expect(s.pid, "no group signal: 981 holds the server").toBeGreaterThan(0);
    expect(stops.map((s) => s.pid).sort()).toEqual([60123, 60130]);
  });

  test("a CLI inside the tree refuses the whole freeze and turns the freezer off", async () => {
    const procs = [
      ...BASE,
      ...shell(51000, "bun batteria.ts", { cores: 0.5, footprintGB: 2.1 }),
      // The guard set says this pid is an MCP server of the CLI, and the tree
      // walk says it is a descendant of the shell: the two disagree, so nothing
      // is signalled at all.
      { pid: 39135, ppid: 51004, pgid: 48914, command: "bun run topics-mcp-server.ts", cores: 0.1, footprintGB: 0.2 },
    ];
    const w = world({ procs, sessions: [session({ backgroundBash: [{ command: "bun batteria.ts", startedAt: T0 }] })] });
    await twoBeats(w);
    expect(w.signals.filter((s) => s.sig === "SIGSTOP")).toEqual([]);
    expect(w.logs.join("\n")).toContain("never frozen");
  });

  test("a post-check that finds a guarded process stopped continues everything and stops for good", async () => {
    const procs = [...BASE, ...shell(51000, "bun batteria.ts", { cores: 0.5, footprintGB: 2.1 })];
    const w = world({
      procs,
      sessions: [session({ backgroundBash: [{ command: "bun batteria.ts", startedAt: T0 }] })],
      fakeStopped: [BRIDGE],
    });
    await twoBeats(w);
    expect(w.logs.join("\n")).toContain("guard tripped");
    const stops = w.signals.filter((s) => s.sig === "SIGSTOP").map((s) => Math.abs(s.pid));
    const resumed = w.signals.filter((s) => s.sig === "SIGCONT").map((s) => Math.abs(s.pid));
    for (const pid of stops) expect(resumed).toContain(pid);
    expect(w.freezer.views()).toHaveLength(0);
    // And it does not try again: the recogniser was wrong, and a second try
    // would be wrong the same way.
    w.advance(200_000);
    const before = w.signals.length;
    await w.beat();
    expect(w.signals.length).toBe(before);
  });
});

describe("the holds every silence clock reads", () => {
  test("a frozen session is a hold, and the frozen time is subtracted from ours", async () => {
    const procs = [...BASE, ...shell(51000, "bun batteria.ts", { cores: 0.5, footprintGB: 2.1, residentGB: 1.4 })];
    const w = world({ procs, sessions: [session({ backgroundBash: [{ command: "bun batteria.ts", startedAt: T0 }] })] });
    const toolStartedAt = T0 - 60_000;
    await twoBeats(w);
    expect(w.freezer.isHold("topic:a")).toBe(true);
    w.advance(120_000);
    expect(w.freezer.frozenMsSince("topic:a", toolStartedAt), "the freeze landed on the second beat").toBe(120_000);
    await w.beat({ sustained: false, heldGB: 9 });
    expect(w.freezer.isHold("topic:a")).toBe(false);
    // The closed interval still counts: the tool ran through it.
    expect(w.freezer.frozenMsSince("topic:a", toolStartedAt)).toBeGreaterThan(100_000);
  });
});
