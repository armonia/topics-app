/**
 * Shared exponential-backoff delay for a bounded PUT-retry loop.
 *
 * `tombstoneSync.ts` and `projectLayoutSync.ts` each reimplemented the exact
 * same formula (±20% jitter, so a WS-reconnect retry storm across many tabs
 * doesn't re-PUT in lockstep) under a private `backoff()`. Extracted here so
 * the two stay in sync by construction instead of by copy-paste discipline.
 *
 * `syncServer.ts`'s retry chain is NOT folded in: its backoff is entangled
 * with AbortController coalescing (a newer PUT aborts an older one mid-delay,
 * see that file's `backoffDelay`), which this plain sleep doesn't support.
 * Left as a possible future consolidation rather than forcing a fit.
 */
const DEFAULT_BASE_BACKOFF_MS = 200;

export function backoff(attempt: number, baseMs: number = DEFAULT_BASE_BACKOFF_MS): Promise<void> {
  const ms = baseMs * Math.pow(2, attempt) * (0.8 + Math.random() * 0.4);
  return new Promise((r) => setTimeout(r, ms));
}
