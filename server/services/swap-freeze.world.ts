/**
 * THE FREEZER'S WORLD FOR TESTS: a process table, a clock, a ledger and a
 * signal recorder that refuses a SIGSTOP the way production does. Shared by
 * the test files of `swap-freeze.ts`, which outgrew one file.
 */
import { createSwapFreezer } from "./swap-freeze";
import { createSwapFreezeLedger, type LedgerIo } from "./swap-freeze-ledger";
import { encodeAsPsWould, type AgentSessionRef, type NativeCommandRef, type PsRow } from "../lib/agent-tool-children";
import type { HeldMemory, SwapVerdict } from "./mem-signal";

export const T0 = 1_760_000_000_000;

export const SERVER = 1733;
export const CLI = 38515;
export const BRIDGE = 2382;

export interface ProcSpec {
  pid: number;
  ppid: number;
  pgid?: number;
  command: string;
  /** Core-units this process burns, turned into CPU seconds as the clock moves. */
  cores?: number;
  footprintGB?: number;
  residentGB?: number;
}

export const BASE: ProcSpec[] = [
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
export function shell(pid: number, command: string, opts: { cores?: number; footprintGB?: number; residentGB?: number } = {}): ProcSpec[] {
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

export function world(i: {
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
  /** Turns plus check runs of Topics in flight; absent = not wired. */
  ourWorkInFlight?: () => number;
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
    ourWorkInFlight: i.ourWorkInFlight,
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

export const session = (over: Partial<AgentSessionRef> = {}): AgentSessionRef => ({
  sessionKey: "topic:a", cliPid: CLI, topicId: "a", terminalId: "term-a", taskId: null,
  backgroundBash: [], foregroundBash: [], ...over,
});

/** Two beats: the first has no CPU base, so a rate is measured and not invented. */
export async function twoBeats(w: World, over?: Parameters<World["beat"]>[0]): Promise<void> {
  await w.beat(over);
  w.advance(10_000);
  await w.beat(over);
}
