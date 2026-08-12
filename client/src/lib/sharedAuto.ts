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
