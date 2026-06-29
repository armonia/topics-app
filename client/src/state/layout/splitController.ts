/**
 * splitController — the PURE geometry helpers behind the split system's gestures
 * (P2). The React hook that owns drag state lives in the component layer; the
 * math that decides "which edge did the pointer land on" and "how much weight
 * does this pixel drag move" is isolated here so it's unit-testable and shared by
 * both the standalone and project surfaces.
 */
import { normalizeWeights, type DropEdge, type Rect } from './layoutTree';

/** A tab dropped near an edge SPLITS the target on that edge; dropped in the
 *  middle it joins the target as a tab (no geometry change). */
export type DropZone = DropEdge | 'center';

/**
 * Classify where `(px, py)` falls inside `rect` for a 5-zone drop:
 * the four edge bands (each `edgeFrac` of the way in) and the center. Corners are
 * resolved by "closest edge wins" (the smallest of the four edge distances). A
 * pointer outside the rect clamps to the nearest in-bounds zone.
 */
export function dropZone(rect: Rect, px: number, py: number, edgeFrac = 0.25): DropZone {
  if (rect.width <= 0 || rect.height <= 0) return 'center';
  const rx = clamp01((px - rect.x) / rect.width);
  const ry = clamp01((py - rect.y) / rect.height);
  const dist = { left: rx, right: 1 - rx, top: ry, bottom: 1 - ry };
  const min = Math.min(dist.left, dist.right, dist.top, dist.bottom);
  if (min >= edgeFrac) return 'center';
  // Stable tie-break order: left, right, top, bottom.
  if (min === dist.left) return 'left';
  if (min === dist.right) return 'right';
  if (min === dist.top) return 'top';
  return 'bottom';
}

/**
 * Convert a divider drag measured in PIXELS into a signed weight delta suitable
 * for `resizeAt`, given the split band's total px size along its axis. Dragging
 * the divider 1/4 of the band's width moves 0.25 of the weight. Degenerate band
 * size → 0 (no-op).
 */
export function pxToWeightDelta(bandPx: number, deltaPx: number): number {
  if (!Number.isFinite(bandPx) || bandPx <= 0 || !Number.isFinite(deltaPx)) return 0;
  return deltaPx / bandPx;
}

/**
 * Two-child divider resize on a flat weight array (`resizeAt` reduced to a single
 * band). Shifts `delta` (a signed fraction of the band) from child `idx+1` to
 * `idx`, clamping each to `floor` so neither collapses, leaving every other child
 * untouched; the array is renormalised to sum 1 first so `delta` (from
 * `pxToWeightDelta`) is in the right units. Used to map a divider drag back onto
 * the legacy `widths` / `rowHeights` arrays without going through the full tree.
 *
 * `floor` is passed in (rather than importing a UI constant here) to keep the
 * state layer free of component dependencies — the host threads MIN_PANE_FRACTION.
 * If the band is already smaller than `2*floor`, the floor is relaxed to half the
 * band so the divider still moves (lands at the midpoint) instead of inverting.
 */
export function resizeWeights(weights: number[], idx: number, delta: number, floor: number): number[] {
  if (idx < 0 || idx + 1 >= weights.length) return weights;
  const norm = normalizeWeights(weights);
  const sum = norm[idx] + norm[idx + 1];
  const f = Math.min(floor, sum / 2);
  const na = Math.min(Math.max(norm[idx] + delta, f), sum - f);
  const nb = sum - na;
  return norm.map((w, i) => (i === idx ? na : i === idx + 1 ? nb : w));
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0.5;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
