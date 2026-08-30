/**
 * Cross-device auto-share decision (Tauri desktop).
 *
 * A desktop browser pane renders its private native WKWebView when it's the only
 * viewer (fast, local) and joins the shared server session when another device
 * (phone PWA / web) is watching the SAME context (so both stay in sync). The
 * server exposes `GET /api/browsers/:id/viewers` = the number of live streaming
 * viewers of that context.
 *
 * The count is interpreted relative to the pane's CURRENT render:
 *  - while NATIVE the pane opens no streaming WS, so `count` is exactly the
 *    number of OTHER devices → any (>0) means "someone else is here" → share.
 *  - while SHARED the pane's own streaming WS is counted, so subtract 1 to get
 *    the other devices → 0 others means "I'm alone again" → back to native.
 *
 * This asymmetry is what makes the switch stable (no native↔shared oscillation):
 * native@count=1 → share; shared@count=1 → native; shared@count≥2 → stay shared.
 *
 * …but the subtraction only holds while the server is REALLY counting this pane.
 * It counts WATCHERS (`set_watching`), and a pane that left the screen says so
 * and drops out. Subtracting anyway read "the phone is watching" (1) as "nobody
 * is here" (0): a backgrounded shared pane fell back to native, was counted
 * again on the next poll, and bounced shared→native→shared every 1200ms for as
 * long as the phone looked. Hence `selfWatching`: subtract me only when I'm in.
 */
/** How a desktop pane chooses between its private native WKWebView and the shared
 *  server session. 'auto' (default): native when solo, shared when another device
 *  views the same context. 'native'/'shared': pinned by the user via the toolbar. */
export type ShareMode = 'auto' | 'native' | 'shared';

/**
 * @param viewerCount  what `GET /api/browsers/:id/viewers` reports (watchers).
 * @param currentlyShared  is this pane rendering the shared session right now?
 * @param selfWatching  is this pane on screen (i.e. inside that count)? A pane
 *   that is hidden reports `set_watching:false` and is NOT counted, so it must
 *   not subtract itself. Defaults to true: while visible — the only state in
 *   which the flip matters to a user — the classic subtraction is exact.
 */
export function computeAutoShared(
  viewerCount: number,
  currentlyShared: boolean,
  selfWatching = true,
): boolean {
  const selfCounted = currentlyShared && selfWatching;
  const others = Math.max(0, viewerCount - (selfCounted ? 1 : 0));
  return others >= 1;
}

/**
 * How many polls in a row must agree before the pane actually changes side.
 *
 * IN SAMPLES, NOT IN MILLISECONDS, and that is the whole point. The count is
 * sampled every 2000ms (`useSharedViewerCount`) and the caller used to guard the
 * flip with a 1200ms `setTimeout` it called a debounce. A timer shorter than the
 * sampling period cannot filter a blip - it only postpones it: the single
 * reading committed 800ms before the next poll could contradict it. Counting
 * agreements instead makes the guard independent of both cadences.
 *
 * Two and not three: two costs at most one extra poll (~2s) before the pane
 * follows a phone that really did open the tab, and it already kills every
 * single-sample blip, which is the whole observed population.
 */
export const AUTO_SHARE_CONFIRMATIONS = 2;

/** Where the auto decision stands: the side the pane is on, and how many polls
 *  in a row have now asked for the other one. */
export interface AutoShareState {
  shared: boolean;
  agreeing: number;
}

/**
 * Fold one poll into the decision.
 *
 * `want` is `computeAutoShared(...)` for THIS reading. Agreeing with where the
 * pane already is clears the streak; asking for the other side builds it, and
 * the flip happens only when the streak reaches `AUTO_SHARE_CONFIRMATIONS`.
 *
 * Pure, so the sequence that produced the defect can be written down as a test
 * instead of being reproduced with a phone and a stopwatch.
 */
export function stepAutoShare(state: AutoShareState, want: boolean): AutoShareState {
  if (want === state.shared) return state.agreeing === 0 ? state : { ...state, agreeing: 0 };
  const agreeing = state.agreeing + 1;
  if (agreeing < AUTO_SHARE_CONFIRMATIONS) return { ...state, agreeing };
  return { shared: want, agreeing: 0 };
}
