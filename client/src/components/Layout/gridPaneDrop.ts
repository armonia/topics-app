/**
 * Where a pane dropped on the top-level grid lands, as pure row edits.
 *
 * Every source ends here: a tab of a strip, a row of the column, a pinned
 * tile, a whole cell. The grid used to keep one branch per source, and the
 * column's branch knew only "merge into the cell", so dragging a row onto an
 * edge never split (24/11). The source decides only WHICH key moves; where it
 * lands is the same answer for all of them.
 *
 * The target is a cell KEY, not row and column indices: a drop of a closed
 * chat lands after the chat has opened, a render or two later, when indices
 * may have shifted but the key has not.
 */
import type { PanelGridRow, PanelGridCellStack } from '../../types';
import type { DropZone } from '../../lib/dropZone';
import { MAX_COLS_PER_ROW, MAX_ROWS, MAX_STACK_DEPTH } from './constants';
import { appendColumnWidths, splitColumnWidths } from './gridWidths';
import { addKeysToCellStack, applyVerticalDrop } from './panelGridStacks';

/** Where a drop lands: beside, above, below or onto the cell `targetKey`. */
export interface PaneDropTarget {
  targetKey: string;
  zone: DropZone;
  /** For a centre drop of a whole cell: which side of the target it joins. */
  centerSide?: 'left' | 'right';
  /** A strip's intent: top/bottom insert a full-width row, not a column stack. */
  fullRow?: boolean;
}

/**
 * Deep-clone a row preserving its optional `cellStacks` map. Drop handlers
 * historically did `{ itemKeys: [...r.itemKeys], widths: [...r.widths] }`
 * which silently dropped any sub-stacks; this helper is the single point
 * the layout code uses to clone, so adding new fields to `PanelGridRow`
 * doesn't quietly lose them.
 */
export function cloneRow(row: PanelGridRow): PanelGridRow {
  const clone: PanelGridRow = {
    itemKeys: [...row.itemKeys],
    widths: [...row.widths],
  };
  if (row.cellStacks) {
    clone.cellStacks = Object.fromEntries(
      Object.entries(row.cellStacks).map(
        ([k, s]) => [k, { items: [...s.items], heights: [...s.heights] }],
      ),
    );
  }
  return clone;
}

/** Rename a top-level key in place — slot, width and sub-stack survive.
 *  Used when a multi-tab cell re-keys (its primary left the cell): pruning
 *  the old key and re-appending the new one teleported the cell to row 0. */
export function renameKeyInRow(row: PanelGridRow, from: string, to: string): PanelGridRow {
  const idx = row.itemKeys.indexOf(from);
  if (idx < 0) return row;
  const itemKeys = row.itemKeys.map((k, i) => (i === idx ? to : k));
  const next: PanelGridRow = { itemKeys, widths: row.widths };
  if (row.cellStacks) {
    const { [from]: moved, ...rest } = row.cellStacks;
    const stacks = { ...rest, ...(moved ? { [to]: moved } : {}) };
    if (Object.keys(stacks).length > 0) next.cellStacks = stacks;
  }
  return next;
}

/** Remove a key from whichever sub-stack contains it (heights renormalized,
 *  emptied stack entries dropped). Top-level itemKeys are untouched — used
 *  when the dragged key lives INSIDE a cell's stack, which the top-level
 *  removeKeyFromRow can't see. */
export function removeKeyFromStacks(row: PanelGridRow, key: string): PanelGridRow {
  if (!row.cellStacks) return row;
  let changed = false;
  const out: Record<string, PanelGridCellStack> = {};
  for (const [primary, stack] of Object.entries(row.cellStacks)) {
    const idx = stack.items.indexOf(key);
    if (idx < 0) { out[primary] = stack; continue; }
    changed = true;
    const items = stack.items.filter((_, i) => i !== idx);
    if (items.length === 0) continue; // stack collapses to just the primary
    // Heights track [primary, ...items] — drop the removed item's slot.
    const heights = stack.heights.filter((_, i) => i !== idx + 1);
    const sum = heights.reduce((s, h) => s + h, 0) || 1;
    out[primary] = { items, heights: heights.map(h => h / sum) };
  }
  if (!changed) return row;
  const next: PanelGridRow = { itemKeys: row.itemKeys, widths: row.widths };
  if (Object.keys(out).length > 0) next.cellStacks = out;
  return next;
}

/** Rename a key ANYWHERE in a row — top-level slot / stack HOST key
 *  (renameKeyInRow) AND stack ITEM lists. Returns the same ref when the key
 *  is absent. Used by the pane-id remap listener (draft → topic promotion),
 *  where the promoted cell may live at top level or inside a sub-stack. */
export function renameKeyDeep(row: PanelGridRow, from: string, to: string): PanelGridRow {
  let next = renameKeyInRow(row, from, to);
  if (next.cellStacks) {
    let changed = false;
    const stacks: Record<string, PanelGridCellStack> = {};
    for (const [host, stack] of Object.entries(next.cellStacks)) {
      if (!stack.items.includes(from)) { stacks[host] = stack; continue; }
      changed = true;
      stacks[host] = { ...stack, items: stack.items.map(k => (k === from ? to : k)) };
    }
    if (changed) next = { ...(next === row ? row : next), cellStacks: stacks };
  }
  return next;
}

/**
 * Remove a top-level cell `key` from a row, preserving the OTHER cells'
 * sub-stacks (a bare `{ itemKeys, widths }` rebuild is the exact data loss
 * cloneRow's contract warns about). If the removed key hosted a sub-stack,
 * that entry is detached and returned so the caller decides its fate:
 * re-attach at the destination for a move, or drop it when the additive
 * sync is about to re-home the orphans anyway.
 */
export function removeKeyFromRow(
  row: PanelGridRow,
  key: string,
): { row: PanelGridRow; detachedStack?: PanelGridCellStack } {
  const idx = row.itemKeys.indexOf(key);
  if (idx < 0) return { row };
  const itemKeys = row.itemKeys.filter((_, i) => i !== idx);
  const widths = row.widths.filter((_, i) => i !== idx);
  const total = widths.reduce((s, w) => s + w, 0);
  const next: PanelGridRow = {
    itemKeys,
    widths: itemKeys.length === 0
      ? widths
      : total > 0 ? widths.map(w => w / total) : itemKeys.map(() => 1 / itemKeys.length),
  };
  let detachedStack: PanelGridCellStack | undefined;
  if (row.cellStacks) {
    const { [key]: detached, ...rest } = row.cellStacks;
    detachedStack = detached;
    if (Object.keys(rest).length > 0) next.cellStacks = rest;
  }
  return { row: next, detachedStack };
}

/** Row and column of a top-level cell, or -1/-1. */
export function locateCell(rows: readonly PanelGridRow[], key: string): { rowIdx: number; colIdx: number } {
  for (let r = 0; r < rows.length; r++) {
    const c = rows[r].itemKeys.indexOf(key);
    if (c >= 0) return { rowIdx: r, colIdx: c };
  }
  return { rowIdx: -1, colIdx: -1 };
}

/** The three shapes a new cell can take beside its target. */
function newCellShape(t: PaneDropTarget) {
  const fullRow = (t.zone === 'top' || t.zone === 'bottom') && !!t.fullRow;
  return {
    fullRow,
    stackBelow: t.zone === 'bottom' && !t.fullRow,
    stackAbove: t.zone === 'top' && !t.fullRow,
  };
}

/**
 * Would a NEW cell beside `t` break a cap? Asked BEFORE anything moves: a
 * pane taken out of its cell and then refused a slot was left marked solo
 * with no home, and the additive sync appended it past the column cap.
 */
export function newCellOverCap(rows: readonly PanelGridRow[], t: PaneDropTarget): boolean {
  const { fullRow, stackBelow, stackAbove } = newCellShape(t);
  const { rowIdx } = locateCell(rows, t.targetKey);
  if (fullRow) return rows.length >= MAX_ROWS;
  if (stackBelow || stackAbove) {
    const depth = rowIdx >= 0 ? (rows[rowIdx]?.cellStacks?.[t.targetKey]?.items.length ?? 0) + 1 : 1;
    return depth >= MAX_STACK_DEPTH;
  }
  return (rows[rowIdx]?.itemKeys.length ?? 0) >= MAX_COLS_PER_ROW;
}

/**
 * A pane that leaves its cell (or the pool) and gets a cell of its own,
 * `newKey`, beside the target. `remainderKey`: when the pane was the PRIMARY
 * of a multi-tab cell, that cell survives in place under its next member.
 */
export function placeNewCell(
  prev: PanelGridRow[],
  newKey: string,
  remainderKey: string | null,
  t: PaneDropTarget,
): PanelGridRow[] {
  if (locateCell(prev, t.targetKey).rowIdx < 0) return prev;
  const { fullRow, stackBelow, stackAbove } = newCellShape(t);
  // Kept as in-updater defense: the caller's pre-check read a ref that could
  // lag a concurrent update.
  if (newCellOverCap(prev, t)) return prev;

  let rows = prev.map(cloneRow);
  if (remainderKey) {
    rows = rows.map(row => renameKeyDeep(row, newKey, remainderKey));
  } else {
    // Safety: drop newKey if already present. Sibling cells' sub-stacks
    // survive; newKey's own stale stack entry is dropped — the solo-cells
    // change reruns the additive sync, which re-homes any live orphans.
    rows = rows.map(row => removeKeyFromRow(row, newKey).row).filter(r => r.itemKeys.length > 0);
  }

  // The target may BE the source cell (primary self-extraction): after the
  // rename above it lives under `remainderKey`.
  const findKey = remainderKey && t.targetKey === newKey ? remainderKey : t.targetKey;
  const { rowIdx: tRow, colIdx: tCol } = locateCell(rows, findKey);
  if (tRow === -1) return rows;

  if (fullRow) {
    const insertIdx = t.zone === 'top' ? tRow : tRow + 1;
    return [...rows.slice(0, insertIdx), { itemKeys: [newKey], widths: [1] }, ...rows.slice(insertIdx)];
  }
  if (stackBelow || stackAbove) {
    // Stack under / above the target's column (cellStacks): what the half-cell
    // preview promised and what the menu Split Down builds.
    const stacked = addKeysToCellStack(rows[tRow], findKey, [newKey], stackBelow ? 'bottom' : 'top');
    if (!stacked) return prev;
    return rows.map((r, i) => (i === tRow ? stacked : r));
  }
  const row = rows[tRow];
  const insertAt = t.zone === 'right' || (t.zone === 'center' && t.centerSide === 'right') ? tCol + 1 : tCol;
  const itemKeys = [...row.itemKeys.slice(0, insertAt), newKey, ...row.itemKeys.slice(insertAt)];
  // Split the target column's width with the new one; siblings keep their
  // manual sizes.
  return rows.map((r, i) => (i === tRow
    ? { itemKeys, widths: splitColumnWidths(r.widths, tCol, insertAt), ...(r.cellStacks ? { cellStacks: r.cellStacks } : {}) }
    : r));
}

/** Pull `key` out of row `srcRow` (top-level or from a host's stack). */
function detach(rows: PanelGridRow[], srcRow: number, inStack: boolean, key: string) {
  let movedStack: PanelGridCellStack | undefined;
  const next = rows.map((r, i) => {
    if (i !== srcRow) return r;
    if (inStack) return removeKeyFromStacks(r, key);
    const res = removeKeyFromRow(r, key);
    movedStack = res.detachedStack;
    return res.row;
  }).filter(r => r.itemKeys.length > 0);
  return { rows: next, movedStack };
}

/**
 * A whole cell `key` moves beside the target. A cell whose target vanished
 * since the drag began goes to the end of the last row (or a new row when
 * that one is full).
 */
export function moveCell(prev: PanelGridRow[], key: string, t: PaneDropTarget): PanelGridRow[] {
  // Source: top-level itemKeys OR inside a cell's sub-stack. A pane split
  // DOWN lives only in cellStacks[host].items.
  let srcRow = -1;
  let srcInStack = false;
  for (let r = 0; r < prev.length; r++) {
    if (prev[r].itemKeys.includes(key)) { srcRow = r; break; }
    const stacks = prev[r].cellStacks;
    if (stacks && Object.values(stacks).some(s => s.items.includes(key))) { srcRow = r; srcInStack = true; break; }
  }
  if (srcRow === -1) return prev;
  const targetPresent = locateCell(prev, t.targetKey).rowIdx >= 0;

  if (!targetPresent || key === t.targetKey) {
    if (targetPresent || prev.length === 0) return prev;
    const { rows, movedStack } = detach(prev.map(cloneRow), srcRow, srcInStack, key);
    const lastRow = rows[rows.length - 1];
    if (!lastRow) return prev;
    if (lastRow.itemKeys.length >= MAX_COLS_PER_ROW) {
      if (rows.length >= MAX_ROWS) return prev;
      return [...rows, { itemKeys: [key], widths: [1], ...(movedStack ? { cellStacks: { [key]: movedStack } } : {}) }];
    }
    return rows.map((r, i) => {
      if (i !== rows.length - 1) return r;
      const stacks = { ...(r.cellStacks ?? {}), ...(movedStack ? { [key]: movedStack } : {}) };
      return {
        itemKeys: [...lastRow.itemKeys, key],
        widths: appendColumnWidths(lastRow.widths, 1),
        ...(Object.keys(stacks).length > 0 ? { cellStacks: stacks } : {}),
      };
    });
  }

  const { rows, movedStack } = detach(prev.map(cloneRow), srcRow, srcInStack, key);
  const { rowIdx: tRow, colIdx: tCol } = locateCell(rows, t.targetKey);
  if (tRow === -1) return rows;
  if ((t.zone === 'left' || t.zone === 'right' || t.zone === 'center') && rows[tRow].itemKeys.length >= MAX_COLS_PER_ROW) return rows;

  if (t.zone === 'top' || t.zone === 'bottom') {
    // A bare cell edge stacks in the target's column; only a strip's
    // `fullRow` intent inserts a spanning row.
    return applyVerticalDrop({
      rows,
      targetRowIdx: tRow,
      targetKey: t.targetKey,
      moved: { key, stack: movedStack },
      edge: t.zone,
      fullRowIntent: !!t.fullRow,
    }) ?? rows;
  }
  const row = rows[tRow];
  const insertAt = t.zone === 'right' || (t.zone === 'center' && t.centerSide === 'right') ? tCol + 1 : tCol;
  const itemKeys = [...row.itemKeys.slice(0, insertAt), key, ...row.itemKeys.slice(insertAt)];
  return rows.map((r, i) => {
    if (i !== tRow) return r;
    const stacks = { ...(r.cellStacks ?? {}), ...(movedStack ? { [key]: movedStack } : {}) };
    return {
      itemKeys,
      widths: splitColumnWidths(r.widths, tCol, insertAt),
      ...(Object.keys(stacks).length > 0 ? { cellStacks: stacks } : {}),
    };
  });
}
