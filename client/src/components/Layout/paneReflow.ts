/**
 * Native browser panes are OS-level WebContentsViews that don't follow the
 * DOM reflow on their own. A split rearranges cells and, during the
 * transition, can briefly leave a view overlapping the NEW tab strip — a
 * mousedown on that tab then hits the view, not the tab, so the tab "won't
 * drag" right after splitting a browser out. Hide every browser view for the
 * reflow (the same signal a divider-resize uses, see SplitTree/useGridResize)
 * and re-measure once it settles.
 *
 * Call past every limit/guard check in the caller so a no-op split never
 * flashes the views. 400ms is a fixed settle window (no real drag end to key
 * off of, unlike the divider-resize start/end pairs elsewhere) — long enough
 * for the grid's CSS transition plus a layout pass.
 */
export function notifyPaneReflow(): void {
  window.dispatchEvent(new Event('topics:pane-resize-start'));
  setTimeout(() => window.dispatchEvent(new Event('topics:pane-resize-end')), 400);
}
