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
 *
 * `detail.reflow` tells the native-view drag gate this start has no pointer
 * behind it: its belt (a `pointermove` with no button) must not end it.
 */
export function notifyPaneReflow(): void {
  window.dispatchEvent(new CustomEvent('topics:pane-resize-start', { detail: { reflow: true } }));
  setTimeout(() => window.dispatchEvent(new CustomEvent('topics:pane-resize-end', { detail: { reflow: true } })), 400);
}
