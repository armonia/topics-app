/**
 * A pane hidden behind another tab stays mounted with `display: none` (see
 * `Layout/PaneKeepAlive.tsx`), and from there every ResizeObserver inside it
 * reports a 0x0 box. That is not a measure, it is the absence of a box. Whoever
 * stores it as a real height re-renders a pane nobody is looking at and, on the
 * way back, paints the first frame with the wrong geometry (tab-switch audit 2026-09-29, PERF-01: the
 * chat list 107 px too low for two frames, then the jump).
 *
 * Width AND height at zero, not the height alone: an empty element that is in
 * the layout still has the width of its column.
 */
export function hasNoBox(rect: { readonly width: number; readonly height: number }): boolean {
  return rect.width === 0 && rect.height === 0;
}
