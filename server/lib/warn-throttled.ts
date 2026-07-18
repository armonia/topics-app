// Throttled console.warn for LOAD-BEARING catch{} blocks.
//
// Some swallowed errors are recoverable (a corrupt DB row, a transient
// misconfig) so we intentionally keep the swallow — but silent is wrong: the
// operator never learns the data is drifting. warnThrottled makes those catches
// observable without flooding the log when the same bad row/config recurs in a
// tight loop (hydrating a message list, a reconcile tick, …). One line per key
// per window; the key groups related failures so a burst collapses to one warn.

const lastWarnAt = new Map<string, number>();

const DEFAULT_WINDOW_MS = 60_000;

/**
 * console.warn at most once per `windowMs` for a given `key`. Extra args are
 * forwarded to console.warn (the error, context, …) exactly as-is.
 */
export function warnThrottled(key: string, ...args: unknown[]): void {
  const now = Date.now();
  const last = lastWarnAt.get(key);
  if (last !== undefined && now - last < DEFAULT_WINDOW_MS) return;
  lastWarnAt.set(key, now);
  console.warn(...args);
}
