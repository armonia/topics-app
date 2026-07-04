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
