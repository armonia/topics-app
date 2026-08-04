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

// Subscribers used by `useServerHydrated()` (React hook below). One-shot:
// once we mark hydrated, every listener fires and the set is cleared. There
// is no "un-hydrate" transition during a session, so we don't bother with a
// per-listener unsubscribe contract beyond the standard cleanup.
const listeners = new Set<() => void>();

/**
 * Mark that this tab has received an authoritative server state. Idempotent.
 * Called by syncWS on `ui-state:init` / `ui-state:updated`, and by the
 * bootstrap fallback GET when it succeeds.
 *
 * ⚠︎ I listener partono in una MICRO-TASK, non qui dentro. Non è una sfumatura:
 * i due chiamanti marcano PRIMA di aver applicato lo snapshot —
 * `syncWS.ts` fa `markServerHydrated()` e solo dopo (nella stessa esecuzione
 * sincrona) dispatcha `HYDRATE_FROM_SNAPSHOT`, e `bootstrap.ts` fa lo stesso.
 * Un listener chiamato sul posto girerebbe quindi PRIMA che lo stato idratato
 * esista, cioè esattamente nel punto della corsa da cui chi si iscrive sta
 * cercando di uscire (il permalink che apre una tab prima dell'idratazione, e
 * l'idratazione che gliela porta via — TABLINK-06). La micro-task scatta appena
 * lo stack sincrono si svuota, cioè a dispatch AVVENUTO.
 *
 * Rende anche vera la promessa che `onServerHydrated` già faceva a parole:
 * «stesso confine di dispatch nel cold-boot e nel warm-mount» — il ramo
 * warm-mount usava `queueMicrotask` da sempre, questo no.
 */
export function markServerHydrated(): void {
  if (serverHydrated) return;
  serverHydrated = true;
  // Snapshot before iterating: a listener may synchronously trigger another
  // mark/subscribe and we don't want to re-fire it in the same flush.
  const toFire = Array.from(listeners);
  listeners.clear();
  for (const l of toFire) {
    queueMicrotask(() => {
      try { l(); } catch { /* listener errors must not poison hydration */ }
    });
  }
}

/** True iff `markServerHydrated()` has fired at least once this session. */
export function hasReceivedServerHydrate(): boolean {
  return serverHydrated;
}

/**
 * Subscribe to the one-shot hydrate signal. Listener fires exactly once when
 * `markServerHydrated()` is first called, then is removed automatically. If
 * already hydrated at subscribe time, the listener fires synchronously on
 * the next microtask (so callers can rely on the same dispatch boundary in
 * both the cold-boot and warm-mount paths).
 *
 * Returns an unsubscribe function for the rare case the caller needs to
 * cancel before hydration fires (e.g. an unmount during boot).
 */
export function onServerHydrated(listener: () => void): () => void {
  if (serverHydrated) {
    queueMicrotask(listener);
    return () => {};
  }
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Test-only — reset the flag back to false. Not exported via the barrel. */
export function __resetServerHydratedForTests(): void {
  serverHydrated = false;
  listeners.clear();
}
