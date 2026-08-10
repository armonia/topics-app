/**
 * Browser-pane zoom scale — the single source of truth for the zoom ladder.
 *
 * The zoom control used to keep two out-of-sync notions of "level": the display
 * treated it as an exponent (`1.2 ** level`, an Electron-era zoomFactor model)
 * while the native backend returned a raw percentage. Feeding a percentage into
 * the exponent produced absurd labels (100 → `1.2 ** 100`) and a reset that never
 * read back as 100%. This module makes the *percentage* the only unit, snapped to
 * a fixed Chrome-style ladder so every step is a clean, round integer.
 *
 * Both the toolbar buttons and the keyboard shortcuts move by a single notch
 * regardless of the delta magnitude (only its sign matters), so mixing them can
 * never drift off the ladder.
 */

/** Round zoom percentages, low → high. Mirrors Chrome's presets, bounded 30–300. */
export const ZOOM_STEPS = [30, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300] as const;

/** The neutral zoom level (a member of {@link ZOOM_STEPS}). */
export const DEFAULT_ZOOM = 100;

/** Index of the step nearest to `pct` (ties resolve to the lower step). */
function nearestIndex(pct: number): number {
  let idx = 0;
  let best = Infinity;
  for (let i = 0; i < ZOOM_STEPS.length; i++) {
    const d = Math.abs(ZOOM_STEPS[i] - pct);
    if (d < best) {
      best = d;
      idx = i;
    }
  }
  return idx;
}

/**
 * Snap `current` to the ladder, then move one notch in the direction of `delta`
 * (delta > 0 zooms in, delta < 0 out, delta === 0 just snaps). Clamped to the
 * ladder ends. The result is always a member of {@link ZOOM_STEPS} — a clean
 * integer percentage — so the on-screen label can never show fractional cruft.
 */
export function stepZoom(current: number, delta: number): number {
  let idx = nearestIndex(current);
  if (delta > 0) idx = Math.min(ZOOM_STEPS.length - 1, idx + 1);
  else if (delta < 0) idx = Math.max(0, idx - 1);
  return ZOOM_STEPS[idx];
}

/* --------------------------------------------- keeping zoom on the page --- */

/**
 * Zoom is a property of the DOCUMENT, not of the pane.
 *
 * WKWebView has no zoom API we can reach, so the pane zooms by writing
 * `document.documentElement.style.zoom`. That inline style dies with the
 * document: a navigation, a reload, a back/forward, a link the user clicks —
 * each one hands the pane a fresh document at 100%, while the host's idea of
 * the zoom (and the percentage on the toolbar button) stays where the user left
 * it. The control then reads 150% over a page that is plainly at 100%.
 *
 * It was worst exactly where it was most visible: switching device preset
 * RELOADS the pane on purpose, to make the new User-Agent take effect. So
 * "changing device silently resets zoom" and "zoom drifts from its label" were
 * never two bugs — the second is just the first with a guaranteed trigger.
 *
 * The cure is to stop treating the injection as a one-off command and treat the
 * zoom as something the host keeps TRUE: every poll tick already reads the page,
 * so it reports the zoom the document actually carries and the host re-applies
 * it whenever the document has lost it. Self-healing for every path that can
 * replace a document, including the ones nobody has thought of yet.
 */

/** JS that pins `pct` on the current document. */
export function zoomApplyJs(pct: number): string {
  return `try{document.documentElement.style.zoom='${pct / 100}'}catch(e){}`;
}

/**
 * Read an inline `style.zoom` back as a percentage.
 *
 * The empty string is what a document with no inline zoom reports — which is
 * every freshly-navigated page — and it means 100%, not "unknown". CSS `zoom`
 * accepts both a unitless factor (`1.5`) and a percentage (`150%`); WebKit
 * normalises to the form it was given, so both are parsed. Anything else
 * (`normal`, garbage) is read as neutral.
 */
export function parseZoomStyle(raw: string | null | undefined): number {
  if (!raw) return DEFAULT_ZOOM;
  const s = raw.trim();
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return DEFAULT_ZOOM;
  return s.endsWith('%') ? n : n * 100;
}

/**
 * Has the document lost the zoom we want? The tolerance is half a percentage
 * point: the ladder is made of integers, so anything closer is float noise from
 * the round-trip through a CSS string, not a real difference.
 */
export function zoomDrifted(want: number, reported: string | null | undefined): boolean {
  return Math.abs(parseZoomStyle(reported) - want) > 0.5;
}
