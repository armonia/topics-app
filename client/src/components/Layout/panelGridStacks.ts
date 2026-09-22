/**
 * Vertical sub-stack math for the STANDALONE grid (`PanelGridRow.cellStacks`),
 * the twin of `groupLayoutStacks` on the project surface.
 *
 * It exists because PanelGrid had the same reshape written twice inline, once
 * for a tab coming out of the pool and once for a whole cell being moved, and
 * the two disagreed: the pool path built a column stack while the whole-cell
 * path built a full-width row, so the SAME gesture gave two layouts depending
 * on where the tab had been sitting. One pure function, two call sites, and
 * the heights stay testable without mounting the grid.
 *
 * Height convention (same as the renderer, CellSubStack): a column of N slots
 * stores `items` of length N-1 (the primary lives in `itemKeys`) and `heights`
 * of length N, `heights[0]` belonging to the primary.
 */
import type { PanelGridRow, PanelGridCellStack } from '../../types';
import { MAX_ROWS, MAX_STACK_DEPTH } from './constants';
import { equalizeWidths, splitSlotWidths } from './gridWidths';

export type VerticalEdge = 'top' | 'bottom';

/** Slots in the column headed by `key` (1 = no stack, just the cell). */
export function cellStackDepth(row: PanelGridRow, key: string): number {
  return 1 + (row.cellStacks?.[key]?.items.length ?? 0);
}

/**
 * Stack `newKeys` into the column headed by the top-level cell `targetKey`:
 * `edge: 'bottom'` puts them at the column's foot, `edge: 'top'` at its head,
 * where the first of them becomes the column's new primary (cellStacks are
 * keyed by the primary and render their items BELOW it, so "above" means
 * taking the slot in `itemKeys` and demoting the old primary into the items).
 *
 * `newKeys` is usually one key. It holds more when a moved cell carried its
 * own sub-stack: the model is a flat list per column, so the whole column
 * being moved is flattened into the destination in visual order.
 *
 * The new slots share HALF the height of the slot they replace (the foot slot
 * for 'bottom', the head for 'top') and every other slot keeps the size it was
 * dragged to. The old inline code reset the column to 1/N, which threw away a
 * manual resize on every split, and no preview ever promised 1/N.
 *
 * Returns a NEW row, or null when the target isn't a top-level cell of this
 * row or the column would pass MAX_STACK_DEPTH (callers treat null as "refuse
 * the drop", same as their other cap guards).
 */
export function addKeysToCellStack(
  row: PanelGridRow,
  targetKey: string,
  newKeys: readonly string[],
  edge: VerticalEdge,
): PanelGridRow | null {
  const colIdx = row.itemKeys.indexOf(targetKey);
  if (colIdx < 0 || newKeys.length === 0) return null;

  const existing = row.cellStacks?.[targetKey];
  const visual = [targetKey, ...(existing?.items ?? [])];
  if (visual.length + newKeys.length > MAX_STACK_DEPTH) return null;

  // Heights read BEFORE the splice so the donor index still lines up with
  // `visual`. A stored array of the wrong length is corrupt persisted state:
  // fall back to an even column rather than hand a slot somebody else's size.
  const prevHeights =
    existing && existing.heights.length === visual.length
      ? existing.heights
      : equalizeWidths(visual.length);
  const donorIdx = edge === 'bottom' ? visual.length - 1 : 0;
  const insertAt = edge === 'bottom' ? visual.length : 0;
  const heights = splitSlotWidths(prevHeights, donorIdx, insertAt, newKeys.length);

  const nextVisual = edge === 'bottom' ? [...visual, ...newKeys] : [...newKeys, ...visual];
  const primaryKey = nextVisual[0];
  const stack: PanelGridCellStack = { items: nextVisual.slice(1), heights };

  const cellStacks: Record<string, PanelGridCellStack> = { ...(row.cellStacks ?? {}) };
  // On a 'top' insert the old primary no longer heads a stack, so its key goes.
  if (primaryKey !== targetKey) delete cellStacks[targetKey];
  cellStacks[primaryKey] = stack;

  return {
    ...row,
    itemKeys: row.itemKeys.map((k, i) => (i === colIdx ? primaryKey : k)),
    widths: [...row.widths],
    cellStacks,
  };
}

/** The column headed by `key`, flattened top-to-bottom (primary first). Used
 *  to move a whole cell, sub-stack included, into another column. */
export function flattenCellColumn(row: PanelGridRow, key: string): string[] {
  return [key, ...(row.cellStacks?.[key]?.items ?? [])];
}

/** A whole cell on the move: its key plus the sub-stack it was hosting. */
export interface MovedCell {
  key: string;
  stack?: PanelGridCellStack;
}

export interface VerticalDropArgs {
  /** Rows with the moved cell ALREADY removed. */
  rows: readonly PanelGridRow[];
  /** Index (in `rows`) of the row holding the drop target. */
  targetRowIdx: number;
  /** Top-level cell key the drop landed on. */
  targetKey: string;
  moved: MovedCell;
  edge: VerticalEdge;
  /**
   * True only for the full-width strips and the row dividers, which mean "a
   * row spanning every column". A bare cell edge never means that.
   */
  fullRowIntent: boolean;
}

/**
 * Where a top/bottom drop puts the moved cell: a new row spanning the grid
 * (strips only) or a slot inside the target's own column (every other case).
 *
 * This is the ONE answer for both drop sources. PanelGrid used to decide it
 * twice: a tab dragged out of the pool built a column stack, while a tab that
 * already owned a cell fell through to the whole-cell reorder and built a
 * FULL-WIDTH row instead. Same gesture, same preview (half of the target
 * cell), two layouts depending only on where the tab happened to live.
 *
 * Returns null when the drop must be refused (grid caps, or a target that
 * isn't a top-level cell of `rows[targetRowIdx]`).
 */
export function applyVerticalDrop(args: VerticalDropArgs): PanelGridRow[] | null {
  const { rows, targetRowIdx, targetKey, moved, edge, fullRowIntent } = args;
  const row = rows[targetRowIdx];
  if (!row) return null;

  if (fullRowIntent) {
    if (rows.length >= MAX_ROWS) return null;
    const newRow: PanelGridRow = {
      itemKeys: [moved.key],
      widths: [1],
      ...(moved.stack ? { cellStacks: { [moved.key]: moved.stack } } : {}),
    };
    const insertIdx = edge === 'top' ? targetRowIdx : targetRowIdx + 1;
    return [...rows.slice(0, insertIdx), newRow, ...rows.slice(insertIdx)];
  }

  const stacked = addKeysToCellStack(row, targetKey, [moved.key, ...(moved.stack?.items ?? [])], edge);
  if (!stacked) return null;
  return rows.map((r, i) => (i === targetRowIdx ? stacked : r));
}
