/**
 * How often the turn is allowed to rewrite its `blocks` column.
 *
 * ## The cost this exists to stop
 *
 * `blocks` is ONE column holding the whole timeline of the turn, so persisting
 * it always means rewriting all of it. Until now every tool event did exactly
 * that, twice (`blocks` and `tool_calls`), with no throttle: a turn with 127
 * blocks on the live database reached 3.65 MB per column, so around 250
 * rewrites of 1.8 MB on average, hundreds of MB of JSON and of SQLite pages
 * for ONE message, all on the event loop while the same turn needs it for
 * tokens, WS frames and PTY. The cost of a turn grew with the SQUARE of its
 * length: the n-th event pays for the n-1 that came before it.
 *
 * ## The rule
 *
 * A write happens when one of these is true:
 *
 *  - it is FORCED: the turn is ending, or a person is about to look at that
 *    row (a tool going `waiting_for_input`). Correctness beats bytes.
 *  - it is the FIRST write of the turn: the row must show something.
 *  - the payload has DOUBLED since the last write. Each write being twice the
 *    previous one makes the bytes of a whole turn a geometric series: about 3x
 *    the final size counting the one that closes the turn, instead of O(n^2).
 *  - a pending change has waited long enough: `lastSize / 512` ms, between 1
 *    and 15 seconds. Which is to say block persistence spends at most about
 *    half a megabyte per second of writes, whatever the size of the blob.
 *
 * ## What a delayed write costs
 *
 * Nothing for whoever is watching: the live clients get every event over the
 * WS as it happens, and the row is only read again on a reload or after a
 * crash. So the worst case is a reload landing mid-turn and seeing a timeline
 * that stops a few seconds short, or a crash losing that same window. Against
 * it: the turn stops fighting itself for the event loop, which is what made
 * the chat stutter exactly when the agent was working hardest.
 *
 * The deferred write calls `write()`, which serializes the LIVE array: a
 * postponed write is never a stale one, it is a fresher one.
 */

/**
 * Growth factor that earns an immediate write.
 *
 * Doubling makes the writes a geometric series that sums to ~2x the final
 * size, and the forced write that closes the turn adds one more: ~3x in total,
 * against the ~100x measured on the same turn when every event wrote
 * (server/turn-write-cost.test.ts). 1.5 also bounds it, at ~4x, which is the
 * gate itself: a bound that equals the gate is a gate that fails on a rounding.
 */
const GROWTH_FACTOR = 2;
/** Bytes of write budget per millisecond of waiting: this is the ~0.5 MB/s ceiling. */
const BYTES_PER_MS = 512;
/** A pending change never waits less than this. */
const MIN_DELAY_MS = 1_000;
/** ...nor longer than this, however big the blob gets. */
const MAX_DELAY_MS = 15_000;

export interface BlockPersistThrottle {
  /**
   * Ask for the row to be persisted. `sizeBytes` is the size of the payload,
   * exact or estimated: it only decides WHEN, never what gets written.
   */
  persist(sizeBytes: number, force?: boolean): void;
  /** Write now if something is pending. The turn ending calls this. */
  flush(): void;
  /** Drop the pending timer without writing. */
  dispose(): void;
  /** Diagnostics for the tests: how many writes went through, and how many were deferred. */
  readonly stats: { writes: number; deferred: number };
}

export interface BlockPersistThrottleOptions {
  /** Does the actual persistence. Called synchronously by `persist`/`flush`, or from the timer. */
  write: () => void;
}

export function createBlockPersistThrottle(opts: BlockPersistThrottleOptions): BlockPersistThrottle {
  let lastSize = -1;
  let pendingSize: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stats = { writes: 0, deferred: 0 };

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const doWrite = (size: number) => {
    clearTimer();
    pendingSize = null;
    lastSize = size;
    stats.writes++;
    opts.write();
  };

  const schedule = () => {
    if (timer !== null) return;
    const delay = Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, Math.floor(Math.max(lastSize, 0) / BYTES_PER_MS)));
    timer = setTimeout(() => {
      timer = null;
      if (pendingSize !== null) doWrite(pendingSize);
    }, delay);
    // A pending write must never keep the process alive on its own: the turn
    // that owns it is what decides how long this server stays up.
    (timer as { unref?: () => void }).unref?.();
  };

  return {
    stats,
    persist(sizeBytes: number, force = false) {
      if (force || lastSize < 0 || sizeBytes >= lastSize * GROWTH_FACTOR) {
        doWrite(sizeBytes);
        return;
      }
      pendingSize = sizeBytes;
      stats.deferred++;
      schedule();
    },
    flush() {
      if (pendingSize !== null) doWrite(pendingSize);
      else clearTimer();
    },
    dispose() {
      clearTimer();
      pendingSize = null;
    },
  };
}
