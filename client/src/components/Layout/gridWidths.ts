/**
 * Width math for the pane grid, shared by the PROJECT layout
 * (useProjectLayout `rows[].widths`) and the STANDALONE grid (PanelGrid
 * `gridRows[].widths`) so both reshape a row the same way.
 *
 * The flex columns use `${width} 1 0%`, so a row's widths are *relative*
 * weights, normalised to sum 1 after every edit.
 *
 * The whole point of this module: splitting/inserting a column must preserve
 * the relative widths of the UNAFFECTED columns. The old code reset the entire
 * row to `1/n` on every insert, so a manual `[0.3, 0.7]` resize was flattened
 * to equal thirds on the next split — the "dragging resets my layout" bug.
 */

/**
 * Insert a new column at `insertAt`, giving it half of the `donorIdx` column's
 * width and leaving every other column's weight untouched. `donorIdx` is the
 * index (in the ORIGINAL `widths`) of the column being split off — i.e. the
 * drop target the new column lands beside.
 *
 * Degenerate input (missing/zero/non-finite donor width) falls back to an equal
 * `1/(n+1)` split so a corrupt row can't strand a column at zero width.
 */
export function splitColumnWidths(
  widths: readonly number[],
  donorIdx: number,
  insertAt: number,
): number[] {
  const donor = widths[donorIdx];
  if (donor === undefined || !Number.isFinite(donor) || donor <= 0) {
    const n = widths.length + 1;
    return new Array(n).fill(1 / n);
  }
  const half = donor / 2;
  const next = [...widths];
  next[donorIdx] = half;
  next.splice(insertAt, 0, half);
  return next;
}

/**
 * Append `newCount` columns to a row, giving each a fair equal share while
 * preserving the RELATIVE proportions of the existing columns. Used when new
 * panes appear (a chat opens) and need a slot — the old code reset the whole
 * row to `1/n`, wiping a manual resize just because a tab was added.
 */
export function appendColumnWidths(existing: readonly number[], newCount: number): number[] {
  if (newCount <= 0) return [...existing];
  if (existing.length === 0) return new Array(newCount).fill(1 / newCount);
  const total = existing.length + newCount;
  const newWeight = 1 / total;
  const combined = [...existing, ...new Array(newCount).fill(newWeight)];
  const sum = combined.reduce((s, w) => s + (Number.isFinite(w) ? w : 0), 0);
  return sum > 0 ? combined.map((w) => w / sum) : combined.map(() => 1 / combined.length);
}

/**
 * Reset a row of `count` columns/rows to perfectly equal weights (`1/count`
 * each). This is the "double-click a divider to even out the split" gesture —
 * mirrors VS Code's "Even Editor Widths" and Allotment's reset-on-double-click.
 * Shared by both grid surfaces (PanelGrid + GroupLayout) and the vertical
 * sub-stack so an equalize means the same thing everywhere. `count <= 0 → []`.
 */
export function equalizeWidths(count: number): number[] {
  if (count <= 0) return [];
  return new Array(count).fill(1 / count);
}

/**
 * Distribute a row/column band proportionally to integer (or fractional)
 * `weights` instead of evenly. This is the WEIGHTED form of `equalizeWidths`:
 * a double-click "equalize" where some cells host more leaf panes than others
 * (e.g. a project window with 3 internal columns) sizes each cell by its leaf
 * count so the *leaves* end up equal, not the cells. Degenerate input (empty,
 * or all weights ≤ 0 / non-finite) falls back to an equal `1/n` split, so it's
 * always safe to pass through whatever weights the caller computed.
 *
 * Like `equalizeWidths`, this does NOT clamp to `MIN_PANE_FRACTION`: a
 * heavily-split neighbor can legitimately shrink a cell below the drag-time
 * floor, which is the correct result of "make every leaf equal". The floor is
 * enforced on the resize-DRAG path; equalize is a deliberate reset (mirrors VS
 * Code "Even Editor Widths", which can also make a pane small).
 */
export function weightedWidths(weights: readonly number[]): number[] {
  if (weights.length === 0) return [];
  const clean = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
  const total = clean.reduce((s, w) => s + w, 0);
  return total > 0 ? clean.map((w) => w / total) : equalizeWidths(weights.length);
}

/**
 * Renormalise a set of weights back to sum 1, preserving relative proportions.
 * All-zero / non-finite input falls back to an equal split. `[]` → `[]`.
 */
export function normalizeWidths(widths: readonly number[]): number[] {
  if (widths.length === 0) return [];
  const clean = widths.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
  const total = clean.reduce((s, w) => s + w, 0);
  return total > 0 ? clean.map((w) => w / total) : widths.map(() => 1 / widths.length);
}

/**
 * Choose how to split a cell when opening a companion pane (e.g. a browser
 * opened by a chat/terminal) based on the available space of the source cell.
 *
 * Landscape cells (wider than ~1.2× their height) split side-by-side so both
 * panes stay readable; portrait / square cells stack so neither pane is
 * squeezed into a sliver. `null`/degenerate rect → `'side'` (the historical
 * default — a new solo cell was always a column).
 *
 * Callers map the logical result onto their own axis vocabulary:
 *   - standalone PanelGrid.handleSplitPane: `'side' → 'right'`, `'stack' → 'down'`
 *   - project handleSplitGroup edges:        `'side' → 'right'`, `'stack' → 'bottom'`
 */
export function chooseSplitOrientation(
  rect: { width: number; height: number } | null | undefined,
): 'side' | 'stack' {
  if (!rect || !Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.height <= 0) {
    return 'side';
  }
  return rect.width > rect.height * 1.2 ? 'side' : 'stack';
}

/**
 * Drop a column at `removeIdx` and renormalise the survivors, preserving their
 * relative proportions. Returns `[]` for a row that empties out (caller decides
 * whether to drop the row).
 */
export function removeColumnWidths(
  widths: readonly number[],
  removeIdx: number,
): number[] {
  return normalizeWidths(widths.filter((_, i) => i !== removeIdx));
}

/**
 * Keep only the columns at `keepIdx` (in order) and renormalise — the
 * multi-column version of removeColumnWidths, used when a row loses one or more
 * groups at once and the survivors must keep their manual proportions.
 */
export function keepColumnWidths(
  widths: readonly number[],
  keepIdx: readonly number[],
): number[] {
  return normalizeWidths(keepIdx.map((i) => widths[i] ?? 0));
}
