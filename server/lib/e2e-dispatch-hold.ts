/**
 * A HOLD on the dispatcher's periodic reconcile — for the E2E bench only.
 *
 * WHY IT EXISTS. `POST /api/test/tasks/:id/bind-topic` stages a task with an
 * agent inside a turn without launching one, which is the only way to test the
 * surface of a dispatched card. That state is, by construction, one production
 * never holds: `in_progress` + a `working` chip with NO live turn behind it.
 * The dispatcher's reconcile is right to recover it — after `LIVENESS_DEAD_
 * SWEEPS` sweeps of a 10s poll, so 10-20 seconds later.
 *
 * That is a race no test can win by being quick, and losing it does not look
 * like a race: the card silently moves column, its DOM node is REPLACED, and
 * whatever the test was doing to that node dies with it. Measured 31/08 on
 * `board-card-stop`: a long-press held on the card, the card re-queued
 * mid-press, React unmounted it, `useLongPress`'s unmount cleanup cleared the
 * armed timer, and the context menu never opened — 1 red in 6 locally, and in
 * CI on 31/08.
 *
 * WHAT IT COSTS IN PRODUCTION: one `Date.now()` comparison every 10 seconds.
 * Nothing can arm it there — the only writer is a route mounted solely on a
 * test server (`server/routes/e2e.ts`, armed by `TOPICS_E2E=1`).
 *
 * TWO SAFETY VALVES, because a dispatcher stuck OFF is worse than a flake:
 *  1. it EXPIRES on its own (the caller passes a window, capped here);
 *  2. `POST /api/test/reset` clears it, so it can never cross the hermetic
 *     boundary into the next spec file even if a spec dies mid-hold.
 */

/** The longest hold a caller can ask for. A spec that needs more is wrong. */
export const DISPATCH_HOLD_MAX_MS = 120_000;

let heldUntil = 0;

/** Suspends the periodic reconcile for `ms` (capped). Returns the deadline. */
export function holdDispatchReconcile(ms: number, now = Date.now()): number {
  const window = Math.max(0, Math.min(ms, DISPATCH_HOLD_MAX_MS));
  heldUntil = window === 0 ? 0 : now + window;
  return heldUntil;
}

/** True while the periodic reconcile must be skipped. */
export function dispatchReconcileHeld(now = Date.now()): boolean {
  return now < heldUntil;
}

/** Drops any hold. Called by the hermetic reset between spec files. */
export function releaseDispatchHold(): void {
  heldUntil = 0;
}
