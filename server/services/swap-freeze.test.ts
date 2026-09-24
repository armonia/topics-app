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
import { encodeAsPsWould, type AgentSessionRef, type NativeCommandRef, type PsRow } from "../lib/agent-tool-children";
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

/**
 * A shell of the CLI: its own group, the command inside its `eval` - WRITTEN THE
 * WAY `ps` WOULD WRITE IT.
 *
 * The fixture used to interpolate the command raw, which made every test here a
 * measurement of a `ps` that does not exist: the real one escapes the single
 * quotes the `eval` forces on it AND rewrites every byte it cannot print (a
 * newline reads `\012`). Fifty-two green tests therefore said nothing about a
 * multi-line command, which is how a foreground command stayed one step from a
 * SIGSTOP.
 */
function shell(pid: number, command: string, opts: { cores?: number; footprintGB?: number; residentGB?: number } = {}): ProcSpec[] {
  const printedByPs = encodeAsPsWould(command).replace(/'/g, `'\\''`);
  return [
    { pid, ppid: CLI, pgid: pid, command: `/bin/zsh -c source ~/.claude/shell-snapshots/snapshot-zsh-1.sh && eval '${printedByPs}' < /dev/null && pwd -P` },
    { pid: pid + 4, ppid: pid, pgid: pid, command: encodeAsPsWould(command), cores: opts.cores ?? 0, footprintGB: opts.footprintGB ?? 0, residentGB: opts.residentGB ?? 0 },
  ];
}

interface World {
  freezer: ReturnType<typeof createSwapFreezer>;
  signals: { pid: number; sig: string }[];
  logs: string[];
  notes: Array<[string, string]>;
  now: () => number;
  advance(ms: number): void;
  beat(over?: { sustained?: boolean; heldGB?: number | null; pagesReadBackPerS?: number | null; debtGBPerMin?: number | null; swapPct?: number | null; brake?: { interrupted: boolean; skipped: string | null } }): Promise<void>;
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
  outsidePeers?: (pids: readonly number[]) => Promise<number[] | null>;
  xpc?: Record<number, number[]>;
  xpcFootprintGB?: number;
  /** `ps` mute: not an empty answer, no answer at all (its own 4 s timeout). */
  psMute?: { lstart?: boolean; table?: boolean; stat?: boolean };
  /** Pids whose SIGSTOP silently does nothing: a command that is not ours to signal. */
  deafPids?: number[];
  /** In the table, but gone by the time `ps` answered with the start times. */
  lstartMissing?: number[];
  /** Called before each `lstartOf`, so a test can kill a pid BETWEEN two reads. */
  onLstart?: (call: number, pids: readonly number[]) => void;
}): World {
  let procs = [...i.procs];
  let clock = T0;
  const signals: { pid: number; sig: string }[] = [];
  const logs: string[] = [];
  const notes: Array<[string, string]> = [];
  const stopped = new Set<number>();
  let lstartCalls = 0;
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
    processTable: async () => (i.psMute?.table ? null : table()),
    footprintKB: (pid) => {
      const own = spec(pid)?.footprintGB ?? 0;
      const asXpc = Object.values(i.xpc ?? {}).some((list) => list.includes(pid)) ? (i.xpcFootprintGB ?? 0) : 0;
      return ((own + asXpc) * 1e9) / 1024;
    },
    residentKB: (pid) => ((spec(pid)?.residentGB ?? 0) * 1e9) / 1024,
    lstartOf: async (pids) => {
      i.onLstart?.(++lstartCalls, pids);
      if (i.psMute?.lstart) return null;
      return new Map(pids
        .filter((p) => (spec(p) || (i.xpc && Object.values(i.xpc).flat().includes(p))) && !(i.lstartMissing ?? []).includes(p))
        .map((p) => [p, `start-${p}`]));
    },
    statOf: async (pids) => (i.psMute?.stat ? null : new Map(pids.map((p) => [p, stopped.has(p) || (i.fakeStopped ?? []).includes(p) ? "T" : "S"]))),
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
      for (const m of members) {
        if ((i.deafPids ?? []).includes(m)) continue;
        if (sig === "SIGSTOP") stopped.add(m); else stopped.delete(m);
      }
    },
    sessions: () => i.sessions ?? [],
    natives: () => i.natives ?? [],
    guardRoles: () => ({ serverPid: SERVER, sidecarPids: [BRIDGE], cliPids: [CLI] }),
    xpcServicePids: async (appPid) => (i.xpc ?? {})[appPid] ?? [],
    outsidePeers: i.outsidePeers ?? (async () => []),
    ledger,
    note: (taskId, text_) => notes.push([taskId, text_]),
    log: (line) => logs.push(line),
  });

  return {
    freezer, signals, logs, stopped, notes,
    now: () => clock,
    advance: (ms) => { clock += ms; },
    ledgerText: () => text,
    setProcs: (list) => { procs = [...list]; },
    async beat(over = {}) {
      const swap: SwapVerdict = {
        sustained: over.sustained ?? true,
        pagesReadBackPerS: over.pagesReadBackPerS ?? 33.6,
        debtGBPerMin: over.debtGBPerMin ?? 8.8,
        swapPct: over.swapPct ?? null,
        coveredMs: 120_000,
      };
      const held: HeldMemory = { measurable: true, latestGB: 4, heldGB: over.heldGB ?? 4, coveredMs: 120_000 };
      await freezer.tick({ swap, held, brake: over.brake ?? { interrupted: false, skipped: "noHeavyRun" } });
    },
  };
}

const session = (over: Partial<AgentSessionRef> = {}): AgentSessionRef => ({
  sessionKey: "topic:a", cliPid: CLI, topicId: "a", terminalId: "term-a", taskId: null,
  backgroundBash: [], foregroundBash: [], ...over,
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
    foregroundBash: ["bun barra.ts && bun prova-3d.ts"],
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

  /**
   * The pose the ceiling door put this code in and that no test held: sustained
   * with the debt FALLING. Verbatim the 12:22:24 line of 16/09/2026 - 167.7
   * pages/s, debt -1.9 GB/min, swap file 92.8% full. Every sentence that
   * explained a freeze hard-coded a `+` in front of the debt, which was true
   * only while `sustained` implied a debt of at least +0.5.
   *
   * @covers KANBAN-75
   */
  test("frozen AT THE CEILING, the card note names the full file and never prints `+-`", async () => {
    const w = world({ procs, sessions: [session({ taskId: "abcdef12-3456", backgroundBash: [{ command: "bun batteria.ts", startedAt: T0 }] })] });
    await twoBeats(w, { debtGBPerMin: -1.9, pagesReadBackPerS: 167.7, swapPct: 0.9277 });
    expect(w.notes).toHaveLength(1);
    expect(w.notes[0]![0]).toBe("abcdef12-3456");
    expect(w.notes[0]![1]).not.toContain("+-");
    expect(w.notes[0]![1]).toContain("Comando congelato, non fermato: il Mac ha il file di swap pieno al 92.8% e rilegge 167.7 pagine/s dal disco (debito -1.9 GB/min)");
    const froze = w.logs.find((l) => l.startsWith("[freeze] froze"))!;
    expect(froze).toContain("swapins 167.7/s, memory debt -1.9 GB/min, swap file 92.8% full");
    expect(froze).not.toContain("+-");
  });

  test("the foreground command is named in the log, so nobody has to guess why", async () => {
    const w = world({ procs, sessions });
    await twoBeats(w);
    expect(w.logs.join("\n")).toContain("foreground Bash, never frozen");
  });

  /**
   * The beat runs every 10 s for the whole swap episode: before this the same
   * line came out on every beat, 46 times for one pid in the production log of
   * 23/09 (1.669 lines out of 5 MB). A fact that does not change is said once,
   * for as long as that pid stays the same.
   */
  test("a foreground command is named ONCE per pid, not on every beat", async () => {
    const w = world({ procs, sessions });
    for (let i = 0; i < 6; i++) { await w.beat(); w.advance(10_000); }
    const lines = w.logs.filter((l) => l.includes("foreground Bash, never frozen"));
    expect(lines).toHaveLength(1);
  });

  test("a new swap episode names the same foreground command again", async () => {
    const w = world({ procs, sessions });
    await twoBeats(w);
    w.advance(10_000);
    await w.beat({ sustained: false });
    // Past the shared action window: the first episode froze a tree, and a
    // beat inside those 120 s returns before measuring anything.
    w.advance(130_000);
    await twoBeats(w);
    const lines = w.logs.filter((l) => l.includes("foreground Bash, never frozen"));
    expect(lines).toHaveLength(2);
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

  test("an `lsof` that did not answer is not a tree with no clients: the candidate is skipped, not frozen", async () => {
    const procs = [
      ...BASE,
      ...shell(51000, "bun run dev", { cores: 0.6, footprintGB: 3.0 }),
      ...shell(52000, "bun batteria.ts", { cores: 0.5, footprintGB: 2.1 }),
    ];
    const sessions = [session({ backgroundBash: [{ command: "bun run dev", startedAt: T0 }, { command: "bun batteria.ts", startedAt: T0 }] })];
    // Under sustained swap - the only condition in which this is ever asked -
    // the 2 s of `lsof` are as likely to expire as the 4 s of `ps`. Reading the
    // silence as "nobody is connected" hangs whoever was connected, for up to
    // ten minutes, instead of failing them.
    const w = world({ procs, sessions, outsidePeers: async (pids) => (pids.includes(51000) ? null : []) });
    await twoBeats(w);
    const stopped = w.signals.filter((s) => s.sig === "SIGSTOP").map((s) => Math.abs(s.pid));
    expect(stopped).not.toContain(51000);
    expect(stopped, "the next heaviest is still tried: a mute probe skips one candidate, not the beat").toContain(52000);
    expect(w.logs.join("\n")).toContain("lsof did not answer");
  });

  test("a multi-line foreground command is not frozen, however stale the background record is", async () => {
    // The whole shape of the T0 blocker: `ps` writes the newline as `\\012`, the
    // record carries the real one, and a background record of an earlier turn is
    // a substring of the same line. Nothing here is parallel or exotic - a
    // heredoc, or an `&&` on the next line, is enough.
    const procs = [
      ...BASE,
      ...shell(51000, "cd /repo\nbun test server/services/swap-freeze.test.ts", { cores: 0.9, footprintGB: 2.6, residentGB: 2.0 }),
    ];
    const sessions = [session({
      backgroundBash: [{ command: "bun test", startedAt: T0 }],
      foregroundBash: ["cd /repo\nbun test server/services/swap-freeze.test.ts"],
    })];
    const w = world({ procs, sessions });
    await twoBeats(w);
    expect(w.signals, "a foreground command is killed by its CLI on a clock that never stopped").toEqual([]);
    expect(w.freezer.views()).toEqual([]);
    expect(w.logs.join("\n")).toContain("foreground Bash, never frozen");
  });

  test("a multi-line background command is a candidate instead of `unrecognised`", async () => {
    const procs = [...BASE, ...shell(51000, "cd /repo\nbun run build:all", { cores: 0.9, footprintGB: 2.6, residentGB: 2.0 })];
    const sessions = [session({ backgroundBash: [{ command: "cd /repo\nbun run build:all", startedAt: T0 }] })];
    const w = world({ procs, sessions });
    await twoBeats(w);
    expect(w.signals.filter((s) => s.sig === "SIGSTOP").map((s) => Math.abs(s.pid))).toContain(51000);
    expect(w.logs.join("\n"), "the lever was blind to exactly the heavy scripts").not.toContain("unrecognised child 51000");
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

/**
 * A `ps` THAT DOES NOT ANSWER IS THE CONDITION THE FREEZER LIVES IN.
 *
 * Its own 4 s timeout fires precisely on a Mac in sustained swap, and until this
 * round every reader turned that into an EMPTY answer: an identity of `""` was
 * written into the ledger for every pid, the SIGSTOPs went out, and the thaw -
 * comparing `""` against the live `lstart` - skipped every one of them. The tree
 * stayed `T` forever, out of the ledger and out of `views()`, with nobody left
 * who knew its numbers.
 */
describe("F13: no identity, no SIGSTOP", () => {
  const procs = [...BASE, ...shell(51000, "bun batteria.ts", { cores: 0.5, footprintGB: 2.1, residentGB: 1.4 })];
  const sessions = [session({ backgroundBash: [{ command: "bun batteria.ts", startedAt: T0 }] })];

  test("a mute `ps` freezes nothing, writes nothing and says why", async () => {
    const w = world({ procs, sessions, psMute: { lstart: true } });
    await twoBeats(w);
    expect(w.signals, "no pid may be stopped with an identity nobody can read").toEqual([]);
    expect(w.freezer.views()).toHaveLength(0);
    const ledger = JSON.parse(w.ledgerText() ?? '{"active":[],"counts":[]}') as { active: unknown[]; counts: unknown[] };
    expect(ledger.active).toEqual([]);
    // And the cap is untouched: a count kept per identity, bumped for an
    // identity of `""`, is a cap that opens on the very beat it must hold.
    expect(ledger.counts).toEqual([]);
    expect(w.logs.join("\n")).toContain("ps did not answer");
  });

  test("a mute `ps` at the fresh table stops the beat before the guard set is built", async () => {
    const w = world({ procs, sessions, psMute: { table: true } });
    await twoBeats(w);
    expect(w.signals).toEqual([]);
    expect(w.logs.join("\n")).toContain("ps did not answer with a process table");
  });

  test("a pid `ps` answered about and did not list is gone: no signal, no ledger line", async () => {
    // The leaf died between the walk and the start times. `ps` DID answer, so
    // this is knowledge, not silence: the pid needs no signal and has no
    // identity to record - and it must not stop the freeze of the rest.
    const w = world({ procs, sessions, lstartMissing: [51004] });
    await twoBeats(w);
    const stopped = w.signals.filter((s) => s.sig === "SIGSTOP").map((s) => Math.abs(s.pid));
    expect(stopped).toContain(51000);
    expect(stopped).not.toContain(51004);
    const recorded = (JSON.parse(w.ledgerText()!).active as { batches: { pids: { pid: number; lstart: string }[] }[] }[])
      .flatMap((t) => t.batches.flatMap((b) => b.pids));
    expect(recorded.map((p) => p.pid)).not.toContain(51004);
    for (const p of recorded) expect(p.lstart, "no empty identity ever reaches the ledger").not.toBe("");
  });

  test("a root that dies BETWEEN the two reads is not frozen half-way", async () => {
    // `measure` reads the start times of the roots, `freeze` reads them again
    // for the whole set: the command can end in between, and stopping the rest
    // of its tree then would leave orphans nobody continues.
    const missing: number[] = [];
    const w = world({
      procs, sessions, lstartMissing: missing,
      onLstart: (call) => { if (call === 3) missing.push(51000); },
    });
    await twoBeats(w);
    expect(w.signals, "nothing is signalled once the root is gone").toEqual([]);
    expect(w.logs.join("\n")).toContain("is already gone");
  });

  test("a freeze whose every SIGSTOP did nothing is not a freeze", async () => {
    const w = world({ procs, sessions, deafPids: [51000, 51004] });
    await twoBeats(w);
    expect(w.logs.join("\n")).toContain("no effect: none of the");
    expect(w.freezer.views(), "no frost over a command that is still running").toHaveLength(0);
    const stops = w.signals.filter((s) => s.sig === "SIGSTOP").map((s) => Math.abs(s.pid));
    const resumed = w.signals.filter((s) => s.sig === "SIGCONT").map((s) => Math.abs(s.pid));
    for (const pid of stops) expect(resumed).toContain(pid);
    expect(JSON.parse(w.ledgerText()!).active).toEqual([]);
  });

  test("a mute `ps` at the post-check leaves the freeze standing, and says it could not check", async () => {
    const w = world({ procs, sessions, psMute: { stat: true } });
    await twoBeats(w);
    expect(w.freezer.views()).toHaveLength(1);
    expect(w.logs.join("\n")).toContain("post-check of \"bun batteria.ts\" skipped");
  });

  test("a mute `ps` at thaw time continues every recorded pid instead of calling it recycled", async () => {
    const mute: { lstart?: boolean } = {};
    const w = world({ procs, sessions, psMute: mute });
    await twoBeats(w);
    const stops = w.signals.filter((s) => s.sig === "SIGSTOP").map((s) => Math.abs(s.pid));
    expect(stops.length).toBeGreaterThan(0);
    mute.lstart = true;
    await w.freezer.thawAll("room");
    const resumed = w.signals.filter((s) => s.sig === "SIGCONT").map((s) => Math.abs(s.pid));
    for (const pid of stops) expect(resumed).toContain(pid);
    expect(w.freezer.views()).toHaveLength(0);
    expect(w.logs.join("\n")).toContain("every recorded pid continued unchecked");
  });

  test("a count whose root is no longer on the machine is forgotten", async () => {
    const w = world({ procs, sessions });
    await twoBeats(w);
    w.advance(60_000);
    await w.beat({ sustained: false, heldGB: 9 });
    expect(JSON.parse(w.ledgerText()!).counts).toHaveLength(1);
    // The command ended: its pid is not in the table any more.
    w.setProcs(BASE);
    w.advance(60_000);
    await twoBeats(w);
    expect(JSON.parse(w.ledgerText()!).counts, "counts grow for every tree ever frozen otherwise").toEqual([]);
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

/**
 * The production error log of 24/09: 1.660 "skipped" lines out of 2 MB, and
 * 8.800 more lines with no prefix at all, because a heredoc or a `for` loop was
 * printed whole on every 10 s beat. A command in the log is one line, cut short;
 * a fact that does not change is said once per pid and per episode.
 */
describe("the freezer log stays one line per fact", () => {
  const script = "python3 - <<'EOF'\nimport sys\nfor i in range(10):\n    print(i)\nEOF\n" + "x".repeat(300);

  test("a multi-line command is logged on ONE line, truncated", async () => {
    const procs = [...BASE, ...shell(51000, script, { cores: 0.9, footprintGB: 2.6 })];
    const w = world({ procs, sessions: [session({ foregroundBash: [script] })] });
    await twoBeats(w);
    const line = w.logs.find((l) => l.includes("foreground Bash, never frozen"))!;
    expect(line).toBeDefined();
    expect(line).not.toContain("\n");
    expect(line).toContain(`"python3 - <<'EOF' import sys for i in range(10): print(i) EOF`);
    expect(line).toContain("…");
    expect(line.length).toBeLessThan(220);
  });

  test("a tree with an agent CLI is named ONCE per pid, not on every beat", async () => {
    const procs = [
      ...BASE,
      ...shell(51000, "bun batteria.ts", { cores: 0.5, footprintGB: 2.1 }),
      { pid: 51010, ppid: 51004, pgid: 51000, command: "claude -p hello" },
    ];
    const w = world({ procs, sessions: [session({ backgroundBash: [{ command: "bun batteria.ts", startedAt: T0 }] })] });
    for (let i = 0; i < 6; i++) { await w.beat(); w.advance(10_000); }
    expect(w.logs.filter((l) => l.includes("contains an agent CLI"))).toHaveLength(1);
  });

  test("a tree reaching a guarded process is named ONCE per pid, not on every beat", async () => {
    const procs = [
      ...BASE,
      ...shell(51000, "bun batteria.ts", { cores: 0.5, footprintGB: 2.1 }),
      { pid: 39135, ppid: 51004, pgid: 48914, command: "bun run topics-mcp-server.ts", cores: 0.1, footprintGB: 0.2 },
    ];
    const w = world({ procs, sessions: [session({ backgroundBash: [{ command: "bun batteria.ts", startedAt: T0 }] })] });
    for (let i = 0; i < 6; i++) { await w.beat(); w.advance(10_000); }
    expect(w.logs.filter((l) => l.includes("reaches a guarded process"))).toHaveLength(1);
  });

  test("the same peer count is said once, a new count is said again", async () => {
    let peers = [777];
    const procs = [...BASE, ...shell(51000, "bun run dev", { cores: 0.6, footprintGB: 3.0 })];
    const w = world({ procs, sessions: [session({ backgroundBash: [{ command: "bun run dev", startedAt: T0 }] })], outsidePeers: async () => peers });
    for (let i = 0; i < 4; i++) { await w.beat(); w.advance(10_000); }
    peers = [777, 778];
    for (let i = 0; i < 3; i++) { await w.beat(); w.advance(10_000); }
    const lines = w.logs.filter((l) => l.includes("established peer(s)"));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("2 established peer(s)");
  });
});
