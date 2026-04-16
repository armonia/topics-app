/**
 * Module-level flag tracking whether this tab has received an authoritative
 * server hydrate signal since boot. Used by `bootstrap.ts` to decide whether
 * the 500 ms `scheduleInitialLoadFallback` GET needs to fire.
 *
 * Why a separate flag (PR-review #14): before this module the fallback gate
 * was `state.lastSeq > 0`, but `lastSeq` bumps for ANY local dispatch —
 * including `OPEN_PANE` / `FOCUS_PANE` called before the 500 ms timer fires.
 * If the WS was down we'd short-circuit the fallback and render the UI with
 * no hydrated data. We now flip `serverHydrated = true` ONLY when:
 *   1. syncWS processes a valid `ui-state:init` or `ui-state:updated` frame,
 *   2. the GET fallback itself completes successfully, or
 *   3. (future) a HYDRATE_FROM_SNAPSHOT with `source: "server"` is dispatched.
 *
 * Module-level (instead of a store field) keeps this orthogonal to the
 * reducer — no new action shape, no type changes, and the store stays a
 * pure function of its action stream. The price is that tests must reset
 * the flag between cases; see `__resetServerHydratedForTests`.
 */

let serverHydrated = false;

/**
 * Mark that this tab has received an authoritative server state. Idempotent.
 * Called by syncWS on `ui-state:init` / `ui-state:updated`, and by the
 * bootstrap fallback GET when it succeeds.
 */
export function markServerHydrated(): void {
  serverHydrated = true;
}

/** True iff `markServerHydrated()` has fired at least once this session. */
export function hasReceivedServerHydrate(): boolean {
  return serverHydrated;
}

/** Test-only — reset the flag back to false. Not exported via the barrel. */
export function __resetServerHydratedForTests(): void {
  serverHydrated = false;
}
