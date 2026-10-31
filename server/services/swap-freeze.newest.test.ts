/**
 * THE LEVER HOLDS THE LATEST ARRIVAL SO THAT THE FIRST ONES FINISH, and its
 * state does not outlive the episode that made it.
 *
 *  - The victim among the trees that pass the floor is the one that started
 *    last; footprint is the way in and the tie-break, never the ranking. The
 *    heaviest was the old build that was nearly done.
 *  - The start time has to reach the candidate from `ps`: with `startedAt: 0`
 *    in `measure` the pure rule stays green and nothing is ordered.
 *  - A CPU base older than two beats is no base: the first beat of a new
 *    episode would otherwise read the average of hours.
 *  - `freezableCommands` is what the CPU governor is handed: the same screen as
 *    a swap candidate, and an empty answer on any doubt.
 *
 * @covers KANBAN-85
 */
import { describe, expect, test } from "bun:test";
import { createSwapFreezer, pickVictim, type FreezeCandidate } from "./swap-freeze";
import { createSwapFreezeLedger } from "./swap-freeze-ledger";
import { encodeAsPsWould, type AgentSessionRef, type PsRow } from "../lib/agent-tool-children";

const T0 = new Date(2026, 9, 31, 10, 0, 0).getTime();
const SERVER = 1733;
const CLI = 38515;
// The records are made after every start, or the stale-record guard skips the command.
const RECORDED = T0;

/** `ps -o lstart=` as macOS prints it, local time. */
function psLstart(ms: number): string {
  const d = new Date(ms);
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()];
  const two = (n: number) => String(n).padStart(2, "0");
  return `${day} ${month} ${String(d.getDate()).padStart(2, " ")} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())} ${d.getFullYear()}`;
}

interface Command {
  pid: number;
  command: string;
  startedAt: number;
  cores?: number;
  footprintGB?: number;
  /** Extra process rows under this command (an agent CLI, an MCP server). */
  children?: Array<{ pid: number; pgid?: number; command: string }>;
}

function scene(i: {
  commands: Command[];
  foreground?: string[];
  peers?: (pids: readonly number[]) => Promise<number[] | null>;
  psMute?: { table?: boolean; lstart?: boolean };
}) {
  let clock = T0;
  const stops: number[] = [];
  const logs: string[] = [];
  const rows = (): PsRow[] => [
    { pid: SERVER, ppid: 1, pgid: SERVER, cpuSeconds: 0, command: "bun run server.ts" },
    { pid: CLI, ppid: 1, pgid: CLI, cpuSeconds: 0, command: "/Applications/claude.app/Contents/MacOS/claude" },
    ...i.commands.flatMap((c) => [
      { pid: c.pid, ppid: CLI, pgid: c.pid, cpuSeconds: 0, command: `/bin/zsh -c eval '${encodeAsPsWould(c.command)}' < /dev/null` },
      { pid: c.pid + 4, ppid: c.pid, pgid: c.pid, cpuSeconds: (c.cores ?? 0.5) * ((clock - T0) / 1000), command: encodeAsPsWould(c.command) },
      ...(c.children ?? []).map((k) => ({ pid: k.pid, ppid: c.pid + 4, pgid: k.pgid ?? c.pid, cpuSeconds: 0, command: k.command })),
    ]),
  ];
  const footprintOf = (pid: number) => i.commands.find((c) => c.pid + 4 === pid)?.footprintGB ?? 0;
  const session: AgentSessionRef = {
    sessionKey: "topic:a", cliPid: CLI, topicId: "a", terminalId: null, taskId: null,
    backgroundBash: i.commands.map((c) => ({ command: c.command, startedAt: RECORDED })),
    foregroundBash: i.foreground ?? [],
  };
  let ledgerText: string | null = null;
  const freezer = createSwapFreezer({
    now: () => clock,
    processTable: async () => (i.psMute?.table ? null : rows()),
    footprintKB: (pid) => (footprintOf(pid) * 1e9) / 1024,
    residentKB: (pid) => (footprintOf(pid) * 0.7 * 1e9) / 1024,
    lstartOf: async (pids) => (i.psMute?.lstart ? null : new Map(pids.map((p) => [
      p, psLstart(i.commands.find((c) => c.pid === p || c.pid + 4 === p)?.startedAt ?? T0 - 86_400_000),
    ]))),
    statOf: async (pids) => new Map(pids.map((p) => [p, stops.includes(p) ? "T" : "S"])),
    signal: (pid, sig) => { if (sig === "SIGSTOP") stops.push(Math.abs(pid)); },
    sessions: () => [session],
    natives: () => [],
    guardRoles: () => ({ serverPid: SERVER, sidecarPids: [], cliPids: [CLI] }),
    xpcServicePids: async () => [],
    outsidePeers: i.peers ?? (async () => []),
    ledger: createSwapFreezeLedger({ read: () => ledgerText, write: (t) => { ledgerText = t; }, log: (l) => logs.push(l) }),
    log: (line) => logs.push(line),
  });
  const beat = () => freezer.tick({
    swap: { sustained: true, pagesReadBackPerS: 33.6, debtGBPerMin: 8.8, swapPct: null, coveredMs: 120_000 },
    held: { measurable: true, latestGB: 4, heldGB: 4, coveredMs: 120_000 },
    brake: { interrupted: false, skipped: "noHeavyRun" },
  });
  return { freezer, stops, logs, beat, advance: (ms: number) => { clock += ms; } };
}

const candidate = (over: Partial<FreezeCandidate>): FreezeCandidate => ({
  root: { kind: "claude-background", pid: 1, pgid: 1, sessionKey: "s", command: "x", topicId: null, terminalId: null, taskId: null },
  treePids: [1], xpcPids: [], footprintGB: 1, residentGB: 1, cpuCores: 1, frozenCount: 0, startedAt: 0, ...over,
});

describe("who is picked", () => {
  test("among the trees that pass the floor the LATEST start is picked, footprint only breaks a tie", () => {
    const oldHeavy = candidate({ footprintGB: 4, startedAt: 1_000 });
    const newLight = candidate({ footprintGB: 0.6, startedAt: 9_000 });
    expect(pickVictim([oldHeavy, newLight]).victim).toBe(newLight);
    expect(pickVictim([newLight, oldHeavy]).victim).toBe(newLight);
    // The footprint is still the way in: a newer tree under the floor is not a candidate.
    expect(pickVictim([oldHeavy, candidate({ footprintGB: 0.1, startedAt: 20_000 })]).victim).toBe(oldHeavy);
    // Same start: the bigger footprint wins, as before.
    const big = candidate({ footprintGB: 3, startedAt: 5_000 });
    expect(pickVictim([candidate({ footprintGB: 1, startedAt: 5_000 }), big]).victim).toBe(big);
  });

  test("measure reads the start time from ps: of two heavy commands the later one is frozen", async () => {
    const s = scene({ commands: [
      { pid: 51000, command: "bun old-build.ts", startedAt: T0 - 3_000_000, footprintGB: 3.0 },
      { pid: 52000, command: "bun new-build.ts", startedAt: T0 - 60_000, footprintGB: 1.0 },
    ] });
    await s.beat();
    s.advance(10_000);
    await s.beat();
    expect(s.stops).toContain(52000);
    expect(s.stops).not.toContain(51000);
    expect(s.freezer.views()[0]!.command).toBe("bun new-build.ts");
  });
});

describe("the CPU base", () => {
  test("a base older than two beats is no base: the first beat after a gap decides nothing", async () => {
    const s = scene({ commands: [{ pid: 51000, command: "bun batteria.ts", startedAt: T0 - 600_000, footprintGB: 2.1 }] });
    await s.beat();
    // Five minutes of calm beats, which return before measuring, then swap again.
    s.advance(300_000);
    await s.beat();
    expect(s.stops).toEqual([]);
    // One more beat is a real ten-second delta, and the command is frozen.
    s.advance(10_000);
    await s.beat();
    expect(s.stops).toContain(51000);
  });
});

describe("freezableCommands: what the CPU governor may pause", () => {
  const gate: Command = { pid: 51000, command: "bun run typecheck", startedAt: T0 - 600_000, cores: 0.9, footprintGB: 0.3 };

  test("a clean background command is offered, with the start time ps gave", async () => {
    const found = await scene({ commands: [gate] }).freezer.freezableCommands();
    expect(found.map((f) => f.root.pid)).toEqual([51000]);
    expect(found[0]!.startedAt).toBe(Math.floor(gate.startedAt / 1000) * 1000);
  });

  test("not offered: a tree somebody outside it is connected to, nor one whose peers were never measured", async () => {
    expect(await scene({ commands: [gate], peers: async () => [4242] }).freezer.freezableCommands()).toEqual([]);
    expect(await scene({ commands: [gate], peers: async () => null }).freezer.freezableCommands()).toEqual([]);
  });

  test("not offered: a foreground command, a tree holding an agent CLI, a tree reaching a guarded pid", async () => {
    expect(await scene({ commands: [gate], foreground: [gate.command] }).freezer.freezableCommands()).toEqual([]);
    const withCli = { ...gate, children: [{ pid: 51010, command: "claude -p hello" }] };
    expect(await scene({ commands: [withCli] }).freezer.freezableCommands()).toEqual([]);
    const guarded = { ...gate, children: [{ pid: 39135, pgid: CLI, command: "bun run topics-mcp-server.ts" }] };
    expect(await scene({ commands: [guarded] }).freezer.freezableCommands()).toEqual([]);
  });

  test("not offered when ps did not answer: a doubt is not a clearance", async () => {
    expect(await scene({ commands: [gate], psMute: { table: true } }).freezer.freezableCommands()).toEqual([]);
    expect(await scene({ commands: [gate], psMute: { lstart: true } }).freezer.freezableCommands()).toEqual([]);
  });

  test("not offered while the swap lever holds it: one lever at a time on a tree", async () => {
    const s = scene({ commands: [{ ...gate, footprintGB: 2.5 }] });
    await s.beat();
    s.advance(10_000);
    await s.beat();
    expect(s.freezer.views()).toHaveLength(1);
    expect(await s.freezer.freezableCommands()).toEqual([]);
  });
});
