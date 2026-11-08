/**
 * The resize handles of a topic's browser window: which edges each one drags,
 * and where it sits around the window's box. They reach OUT of the box, over
 * the DOM around it, because the native page composites above the DOM and a
 * handle drawn over it could never be grabbed.
 */
import type { Rect } from './useAreaRect';
import type { TopicBrowserResizeEdges } from '../../lib/topicBrowserDrag';

/** The resize handles: how far they reach OUT of the window, over the DOM
 *  around it, and how far IN (only grabbable where no native page covers it). */
const HANDLE_OUT_PX = 6;
const HANDLE_IN_PX = 2;
/** Side of a corner handle, the one that drags two edges at once. */
const HANDLE_CORNER_PX = 14;

/** The handles of a floating window: four edges and four corners. */
export const FLOATING_HANDLES: { key: string; edges: TopicBrowserResizeEdges; cursor: string }[] = [
  { key: 'left', edges: { left: true }, cursor: 'ew-resize' },
  { key: 'right', edges: { right: true }, cursor: 'ew-resize' },
  { key: 'top', edges: { top: true }, cursor: 'ns-resize' },
  { key: 'bottom', edges: { bottom: true }, cursor: 'ns-resize' },
  { key: 'top-left', edges: { top: true, left: true }, cursor: 'nwse-resize' },
  { key: 'bottom-right', edges: { bottom: true, right: true }, cursor: 'nwse-resize' },
  { key: 'top-right', edges: { top: true, right: true }, cursor: 'nesw-resize' },
  { key: 'bottom-left', edges: { bottom: true, left: true }, cursor: 'nesw-resize' },
];

/** Where a handle sits, in viewport px, around the window's box. An edge spans
 *  the whole side; the corners are drawn after the edges, so they win where the
 *  two overlap. */
export function handleBox(box: Rect, edges: TopicBrowserResizeEdges): Rect {
  const corner = (edges.left || edges.right) && (edges.top || edges.bottom);
  const size = corner ? HANDLE_CORNER_PX : HANDLE_OUT_PX + HANDLE_IN_PX;
  const horizontal = edges.left
    ? { left: box.left - HANDLE_OUT_PX, width: size }
    : edges.right
      ? { left: box.left + box.width + HANDLE_OUT_PX - size, width: size }
      : { left: box.left, width: box.width };
  const vertical = edges.top
    ? { top: box.top - HANDLE_OUT_PX, height: size }
    : edges.bottom
      ? { top: box.top + box.height + HANDLE_OUT_PX - size, height: size }
      : { top: box.top, height: box.height };
  return { ...horizontal, ...vertical };
}
