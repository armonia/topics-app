/**
 * Post-mount scroll-offset clamp helper.
 *
 * Why this exists (review I3):
 *   `ClosedPaneRecord.scrollOffset` crosses devices for PANE-03 undo fidelity.
 *   Device A may have closed a pane at 1000 px when the container was taller;
 *   device B does the undo with a shorter viewport or different content height.
 *   Blindly assigning `container.scrollTop = offset` would scroll past content
 *   end (browsers clamp, but some virtualized scrollers return stale values).
 *
 *   The REDUCER/SANITIZER can only clamp the lower bound (`>= 0`) — they don't
 *   know the target container's `scrollHeight`. The CONSUMER that applies the
 *   restored offset after mount must call this helper to clamp the upper
 *   bound against the actual scroll extent.
 *
 * Usage:
 *   const safe = clampScrollOffset(pane.scrollOffset, container.scrollHeight, container.clientHeight);
 *   container.scrollTop = safe;
 */
export function clampScrollOffset(
  offset: number | undefined,
  scrollHeight: number,
  clientHeight: number,
): number {
  if (typeof offset !== 'number' || !Number.isFinite(offset) || offset < 0) return 0;
  const max = Math.max(0, scrollHeight - clientHeight);
  if (offset > max) return max;
  return offset;
}
