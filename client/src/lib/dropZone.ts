import { EDGE_DROP_PX } from '../components/Layout/constants';

export type EdgeZone = 'left' | 'right' | 'top' | 'bottom';
export type DropZone = EdgeZone | 'center';

/**
 * Pointer-position → drop-zone classification, shared between PanelGrid
 * and GroupLayout. The `mode` parameter controls whether the inner area
 * resolves to 'center' (5-zone) or `null` (4-zone, edge-only callers).
 *
 * Geometry (v2, relative): the middle box of the cell is 'center'; the outer
 * ring classifies by NEAREST edge (normalized per-axis, so corners split along
 * the diagonal of the ring). Edge depth is 25% of each axis, floored at
 * `edgePx` (tiny panes keep a graspable band) and capped at 45% (a center
 * sliver always survives).
 *
 * The previous model used a fixed `edgePx` (30px) band for the edges and made
 * EVERYTHING else 'center' — on a 1200px-wide pane "split right" was a 30px
 * sliver hugging the border, which read as "you can't split here" in practice.
 * Relative zones make each split target a quarter of the pane, VS Code-style,
 * while 'center' (merge-as-tab) remains the whole middle box.
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
  const w = Math.max(bounds.width, 1);
  const h = Math.max(bounds.height, 1);
  const x = pointer.clientX - bounds.left;
  const y = pointer.clientY - bounds.top;

  const depthX = Math.min(Math.max(edgePx, w * 0.25), w * 0.45);
  const depthY = Math.min(Math.max(edgePx, h * 0.25), h * 0.45);

  const inCenterX = x >= depthX && x <= w - depthX;
  const inCenterY = y >= depthY && y <= h - depthY;
  if (inCenterX && inCenterY) {
    return mode === 'edges+center' ? 'center' : null;
  }

  // Outer ring: nearest edge wins, distances normalized by each axis's ring
  // depth so a corner resolves to whichever edge the cursor is proportionally
  // closer to (ties break in left/right/top/bottom order, matching v1).
  const dl = x / depthX;
  const dr = (w - x) / depthX;
  const dt = y / depthY;
  const db = (h - y) / depthY;
  const min = Math.min(dl, dr, dt, db);
  if (min === dl) return 'left';
  if (min === dr) return 'right';
  if (min === dt) return 'top';
  return 'bottom';
}
