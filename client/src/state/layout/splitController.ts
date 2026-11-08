/**
 * splitController — the PURE geometry helpers behind the split system's DIVIDER
 * gestures (P2). The React hook that owns drag state lives in the component
 * layer; the math that decides "how much weight does this pixel drag move" is
 * isolated here so it's unit-testable and shared by both the standalone and
 * project surfaces.
 *
 * A 5-zone pointer→edge `dropZone` classifier once lived here too, but it had
 * ZERO production callers — the live drop hit-testing is
 * `lib/dropZone.detectDropZone` — so it was removed to keep the shipping surface
 * honest. Recover it from git history if a tree-side drop-split op is ever wired.
 */
import { normalizeWeights } from './layoutTree';

/**
 * Convert a divider drag measured in PIXELS into a signed weight delta suitable
 * for `resizeWeights`, given the split band's total px size along its axis.
 * Dragging the divider 1/4 of the band's width moves 0.25 of the weight.
 * Degenerate band size → 0 (no-op).
 */
export function pxToWeightDelta(bandPx: number, deltaPx: number): number {
  if (!Number.isFinite(bandPx) || bandPx <= 0 || !Number.isFinite(deltaPx)) return 0;
  return deltaPx / bandPx;
}

/**
 * Two-child divider resize on a flat weight array (a single-band resize).
 * Shifts `delta` (a signed fraction of the band) from child `idx+1` to
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
