/**
 * IS THIS PID A LIVE PROCESS, without stopping the event loop to ask `ps`.
 *
 * `kill(pid, 0)` alone is not the answer: it succeeds on a zombie too, a
 * process that has exited and waits for a parent that does not reap it. So the
 * registry asked `ps -o stat=` as well, with a SYNCHRONOUS spawn, once per
 * tracked process every 3 s (and twice per background shell every detector
 * cycle): the whole server, streams and sockets included, stood still for the
 * length of a `ps` each time.
 *
 * Here the state comes without a process:
 *  - on Linux from `/proc/<pid>/stat`, a read of a few dozen bytes;
 *  - elsewhere (macOS has no /proc) from ONE asynchronous `ps` for every pid of
 *    a round (`livePids`), whose zombies are remembered for the synchronous
 *    question (`isPidAlive`) until the next round says otherwise.
 *
 * Failure reads as before: a pid `kill` reaches and no probe could describe is
 * alive, as when `ps` failed or answered nothing.
 */
import { readFileSync } from "node:fs";
import { spawnBounded } from "./bounded-spawn";

export interface PidLivenessDeps {
  /** `kill(pid, 0)`: throws when the pid does not exist (or is not ours to signal). */
  probe: (pid: number) => void;
  /** The state letter of a pid from the process filesystem, `null` when unreadable; absent where there is none. */
  procState?: (pid: number) => string | null;
  /** `pid -> stat` for these pids with one process listing; `null` when the listing failed. */
  psStates: (pids: number[]) => Promise<Map<number, string> | null>;
}

export interface PidLiveness {
  /** Synchronous and spawn-free. Without /proc a zombie is known only once a `livePids` round has seen it. */
  isPidAlive: (pid: number) => boolean;
  /** The live ones among `pids`: no process on Linux, one `ps` for all of them elsewhere. */
  livePids: (pids: Iterable<number>) => Promise<Set<number>>;
}

export function createPidLiveness(deps: PidLivenessDeps): PidLiveness {
  const zombies = new Set<number>();

  function reachableByKill(pid: number): boolean {
    try {
      deps.probe(pid);
      return true;
    } catch {
      zombies.delete(pid);
      return false;
    }
  }

  function isPidAlive(pid: number): boolean {
    if (!reachableByKill(pid)) return false;
    if (deps.procState) return deps.procState(pid) !== "Z";
    return !zombies.has(pid);
  }

  async function livePids(pids: Iterable<number>): Promise<Set<number>> {
    const reachable = [...new Set(pids)].filter(reachableByKill);
    if (deps.procState) return new Set(reachable.filter((pid) => deps.procState!(pid) !== "Z"));
    if (reachable.length === 0) return new Set();
    const states = await deps.psStates(reachable);
    if (states) {
      for (const pid of reachable) {
        if (states.get(pid)?.startsWith("Z")) zombies.add(pid);
        else zombies.delete(pid);
      }
    }
    return new Set(reachable.filter((pid) => !zombies.has(pid)));
  }

  return { isPidAlive, livePids };
}

/** Field 3 of `/proc/<pid>/stat`, after the command name (which may itself hold `)`). */
export function procStatState(stat: string): string | null {
  const end = stat.lastIndexOf(")");
  return end >= 0 ? stat.charAt(end + 2) || null : null;
}

function readProcState(pid: number): string | null {
  try {
    return procStatState(readFileSync(`/proc/${pid}/stat`, "latin1"));
  } catch {
    return null;
  }
}

async function psStates(pids: number[]): Promise<Map<number, string> | null> {
  try {
    const proc = spawnBounded(["ps", "-o", "pid=,stat=", "-p", pids.join(",")], { stdout: "pipe", stderr: "ignore", timeoutMs: 3_000 });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    if (proc.timedOut) return null;
    const out = new Map<number, string>();
    for (const line of text.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(\S+)/);
      if (m) out.set(Number(m[1]), m[2]!);
    }
    return out;
  } catch {
    return null;
  }
}

function hasProcFs(): boolean {
  if (process.platform !== "linux") return false;
  return readProcState(process.pid) !== null;
}

const liveness = createPidLiveness({
  probe: (pid) => { process.kill(pid, 0); },
  ...(hasProcFs() ? { procState: readProcState } : {}),
  psStates,
});

export const isPidAlive = liveness.isPidAlive;
export const livePids = liveness.livePids;

/**
 * Rows watched until their pid is gone: ONE timer and one `livePids` probe per
 * round for all of them, not a timer and a probe per row. Returns `add`.
 */
export function watchPidExits<T>(opts: {
  everyMs: number;
  pidOf: (row: T) => number | null;
  /** Closed by someone else meanwhile: dropped without `onGone`. */
  settled: (row: T) => boolean;
  onGone: (row: T) => void;
  probe?: (pids: number[]) => Promise<Set<number>>;
}): (row: T) => void {
  const rows = new Set<T>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const arm = () => {
    if (!timer && rows.size) timer = setTimeout(() => { void round(); }, opts.everyMs);
  };
  async function round(): Promise<void> {
    try {
      const batch = [...rows];
      const live = await (opts.probe ?? livePids)(batch.flatMap((row) => opts.pidOf(row) ?? []));
      for (const row of batch) {
        if (opts.settled(row)) { rows.delete(row); continue; }
        const pid = opts.pidOf(row);
        if (pid && live.has(pid)) continue;
        rows.delete(row);
        opts.onGone(row);
      }
    } catch (err) {
      // A failed round closes nothing: the next one asks again.
      console.warn("[pid-liveness] exit watch round failed:", err);
    } finally {
      timer = null;
      arm();
    }
  }
  return (row) => { rows.add(row); arm(); };
}
