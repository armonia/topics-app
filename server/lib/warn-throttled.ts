// Throttled console.warn for LOAD-BEARING empty catch blocks.
//
// Some swallowed errors are recoverable (a corrupt DB row, a transient
// misconfig) so we intentionally keep the swallow — but silent is wrong: the
// operator never learns the data is drifting. warnThrottled makes those catches
// observable without flooding the log when the same bad row/config recurs in a
// tight loop (hydrating a message list, a reconcile tick, …). One line per key
// per window; the key groups related failures so a burst collapses to one warn.

const lastWarnAt = new Map<string, number>();

const DEFAULT_WINDOW_MS = 60_000;
/** Above this many remembered keys, the ones whose window has passed are dropped. */
const SWEEP_ABOVE = 256;

/**
 * console.warn at most once per `windowMs` for a given `key`. Extra args are
 * forwarded to console.warn (the error, context, …) exactly as-is.
 */
export function warnThrottled(key: string, ...args: unknown[]): void {
  const now = Date.now();
  const last = lastWarnAt.get(key);
  if (last !== undefined) {
    if (now - last < DEFAULT_WINDOW_MS) return;
    // The window is over: the entry has nothing left to say, so it goes. Keys
    // carrying an id (one per session) would otherwise pile up for good.
    lastWarnAt.delete(key);
  }
  if (lastWarnAt.size >= SWEEP_ABOVE) {
    for (const [k, at] of lastWarnAt) if (now - at >= DEFAULT_WINDOW_MS) lastWarnAt.delete(k);
  }
  lastWarnAt.set(key, now);
  console.warn(...args);
}

/** Number of remembered keys, for tests. */
export function warnThrottledSize(): number {
  return lastWarnAt.size;
}
