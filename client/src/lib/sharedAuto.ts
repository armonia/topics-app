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
 */
/** How a desktop pane chooses between its private native WKWebView and the shared
 *  server session. 'auto' (default): native when solo, shared when another device
 *  views the same context. 'native'/'shared': pinned by the user via the toolbar. */
export type ShareMode = 'auto' | 'native' | 'shared';

export function computeAutoShared(viewerCount: number, currentlyShared: boolean): boolean {
  const others = currentlyShared ? Math.max(0, viewerCount - 1) : Math.max(0, viewerCount);
  return others >= 1;
}
