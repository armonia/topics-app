import { EDGE_DROP_PX } from '../components/Layout/constants';

export type EdgeZone = 'left' | 'right' | 'top' | 'bottom';
export type DropZone = EdgeZone | 'center';

/**
 * Pointer-position → drop-zone classification, shared between PanelGrid
 * and GroupLayout. The `mode` parameter controls whether the inner area
 * resolves to 'center' (5-zone) or `null` (4-zone, edge-only callers).
 *
 * Pass either a React.DragEvent or a raw {clientX, clientY} pair. The
 * `bounds` is whatever DOMRect-shaped object you have on hand
 * (typically `(e.currentTarget as HTMLElement).getBoundingClientRect()`),
 * accepted as a `DOMRect`-like to avoid forcing callers through `as`.
 */
export function detectDropZone(
  pointer: { clientX: number; clientY: number },
  bounds: { left: number; top: number; width: number; height: number },
  mode: 'edges' | 'edges+center' = 'edges+center',
  edgePx: number = EDGE_DROP_PX,
): DropZone | null {
  const x = pointer.clientX - bounds.left;
  const y = pointer.clientY - bounds.top;
  if (x < edgePx) return 'left';
  if (x > bounds.width - edgePx) return 'right';
  if (y < edgePx) return 'top';
  if (y > bounds.height - edgePx) return 'bottom';
  return mode === 'edges+center' ? 'center' : null;
}
