/**
 * THE CIRCUIT BREAKER ON WAKING A NODE.
 *
 * `pickOverflowMachine` treats a sleeping node as a target while a `node-run`
 * hook is declared, and never looked at how the last wakes went. On 2026-11-10
 * the PC was powered on but stuck at the login screen: the hook could not bring
 * it online, yet the dispatcher sent it 8 cards at 17:14 and 8 more at 17:45,
 * each one bouncing through 7 waits into backlog.
 *
 * After `WAKE_FAIL_THRESHOLD` failed wakes in a row the node stops being
 * wakeable for a window that doubles on every further failure (15, 30, 60 min,
 * capped at 4 h). One run that starts closes the breaker.
 *
 * AN OPEN WINDOW OUTLIVES THE PROCESS (`persistNodeBreakers`). It used to live
 * in memory on purpose, "a restart gives the node one fresh try"; but the
 * production server restarts at every land that touches `server/`, many times
 * a day, and every restart handed the broken node that fresh try again: 27
 * cards moved onto one broken PC on 21/11. A window still open is adopted at
 * boot with its failure count, so the next failure keeps doubling it; an
 * expired one is dropped, and a missing or unreadable file is an empty state.
 *
 * `createWakeBreaker` is the same algorithm wired a second time, on its own
 * state, for a node that is already awake and goes mute mid-run
 * (`task-dispatcher-remote-node.ts`'s `hangBreaker`): the two must not share
 * one map, or a run that merely STARTS on a node still hung from the last
 * burial would close a breaker that tracks something else entirely. They share
 * the file only, each in its own section.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const WAKE_FAIL_THRESHOLD = 2;
export const WAKE_OPEN_BASE_MS = 15 * 60_000;
export const WAKE_OPEN_MAX_MS = 4 * 3_600_000;

interface BreakerState { fails: number; openUntil: number }

/** What the file holds: one section per breaker, machine id -> state. Read as untrusted. */
type BreakerFile = Record<string, Record<string, Partial<BreakerState> | null> | null>;

function readBreakerFile(path: string): BreakerFile {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as BreakerFile) : {};
  } catch { return {}; }
}

/** `name` is this breaker's section in the file it may be persisted to. */
export function createWakeBreaker(name: string, clock: () => number = Date.now) {
  const state = new Map<string, BreakerState>();
  let file: string | null = null;
  /** Rewrite this breaker's section, leaving the other one as it is. */
  function save(): void {
    if (!file) return;
    try {
      const all = readBreakerFile(file);
      all[name] = Object.fromEntries(state);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(all));
    } catch { /* The file only carries the window across a restart: a failed write never fails the breaker. */ }
  }
  return {
    /** A wake that did not bring the node online (hook veto, node not ready). */
    failure(machineId: string): void {
      const s = state.get(machineId) ?? { fails: 0, openUntil: 0 };
      s.fails += 1;
      if (s.fails >= WAKE_FAIL_THRESHOLD) {
        const ms = Math.min(WAKE_OPEN_BASE_MS * 2 ** (s.fails - WAKE_FAIL_THRESHOLD), WAKE_OPEN_MAX_MS);
        s.openUntil = clock() + ms;
      }
      state.set(machineId, s);
      save();
    },
    /** A run started on the node: it is reachable again. */
    success(machineId: string): void { if (state.delete(machineId)) save(); },
    /** True while the node must not be chosen as a sleeping target. */
    isOpen(machineId: string): boolean { return (state.get(machineId)?.openUntil ?? 0) > clock(); },
    /** When the breaker closes again, for the note on the card (null = closed). */
    openUntil(machineId: string): number | null {
      const u = state.get(machineId)?.openUntil ?? 0;
      return u > clock() ? u : null;
    },
    /**
     * From now on this breaker also lives in `path`: the windows a previous
     * process left open there are adopted, and every change is written back.
     */
    persistTo(path: string): void {
      file = path;
      const now = clock();
      for (const [machineId, s] of Object.entries(readBreakerFile(path)[name] ?? {})) {
        const fails = s?.fails;
        const openUntil = s?.openUntil;
        if (typeof fails === "number" && typeof openUntil === "number" && openUntil > now) state.set(machineId, { fails, openUntil });
      }
    },
  };
}

/** The one breaker the dispatcher and the remote-node launcher share. */
export const wakeBreaker = createWakeBreaker("wake");

/**
 * A node that accepts runs and then answers no poll of them: its own state,
 * written by `task-dispatcher-remote-node.ts` (see `createWakeBreaker` above).
 */
export const hangBreaker = createWakeBreaker("hang");

/** The file, under the server's state dir, that carries both breakers across a restart. */
export const NODE_BREAKERS_FILE = "node-breakers.json";

/** At boot, before the dispatcher's first tick: both breakers adopt `path` (see the header). */
export function persistNodeBreakers(path: string): void {
  wakeBreaker.persistTo(path);
  hangBreaker.persistTo(path);
}

/**
 * Whether either breaker keeps NEW cards away from this machine, a node or the
 * cloud row (`pickOverflowMachine` reads it for both). The overflow and
 * the reassignment read this one answer: a hung node closed only to the launch
 * still got cards moved onto it, which then waited there up to 4 h while other
 * machines had free seats (21/11).
 */
export function nodeBlocked(machineId: string): boolean {
  return wakeBreaker.isOpen(machineId) || hangBreaker.isOpen(machineId);
}
