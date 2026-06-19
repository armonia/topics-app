/**
 * Per-column vertical-stack math for the PROJECT layout (`GroupLayoutRow`).
 *
 * A row's columns are `groupIds[colIdx]` — one group (with its own tab bar) per
 * column. Splitting a tab "to the bottom" used to insert a FULL-WIDTH row below
 * every column ("in basso a tutte le tab"). To also support splitting a SINGLE
 * column ("in basso a una singola split tab"), a column can carry an optional
 * vertical sub-stack: `row.cellStacks[primaryGroupId]` lists the extra groups
 * stacked UNDER the primary, and the renderer composes the cell as
 * `[primary, ...stack.groupIds]` top-to-bottom — leaving sibling columns
 * full-height.
 *
 * This is the project-window twin of PanelGrid's `cellStacks` (see
 * usePanelGridPersistence + CellSubStack), kept as a separate, fully-pure,
 * unit-tested module so the reducer-ish reshaping never has to reach into React
 * state. Every function returns NEW arrays/objects — callers stay immutable.
 */
import type { GroupLayoutRow, GroupCellStack } from '../../types';
import { MAX_STACK_DEPTH } from './constants';
import { normalizeWidths, equalizeWidths } from './gridWidths';

export type VerticalEdge = 'top' | 'bottom';

/** Where a group lives within a set of rows. */
export interface GroupLocation {
  rowIdx: number;
  colIdx: number;
  /** The primary group id that heads `colIdx`'s column (== row.groupIds[colIdx]). */
  primaryId: string;
  /** True when the located group IS the column primary; false when it's a stacked member. */
  isPrimary: boolean;
}

/** Every group id a row references: column primaries + all stacked members, in
 *  visual order (each column's primary then its stack, left-to-right). */
export function rowGroupIds(row: GroupLayoutRow): string[] {
  const out: string[] = [];
  for (const gid of row.groupIds) {
    out.push(gid);
    const stack = row.cellStacks?.[gid];
    if (stack) out.push(...stack.groupIds);
  }
  return out;
}

/** Every group id across all rows (primaries + stacked). */
export function allGroupIdsInRows(rows: readonly GroupLayoutRow[]): string[] {
  return rows.flatMap(rowGroupIds);
}

/** Locate `groupId` (a primary OR a stacked member). null when absent. */
export function locateGroup(
  rows: readonly GroupLayoutRow[],
  groupId: string,
): GroupLocation | null {
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    for (let c = 0; c < row.groupIds.length; c++) {
      const primaryId = row.groupIds[c];
      if (primaryId === groupId) {
        return { rowIdx: r, colIdx: c, primaryId, isPrimary: true };
      }
      const stack = row.cellStacks?.[primaryId];
      if (stack && stack.groupIds.includes(groupId)) {
        return { rowIdx: r, colIdx: c, primaryId, isPrimary: false };
      }
    }
  }
  return null;
}

/** Number of vertically-stacked groups in the column headed by `primaryId`
 *  (1 = no split, just the primary). */
export function columnDepth(row: GroupLayoutRow, primaryId: string): number {
  return 1 + (row.cellStacks?.[primaryId]?.groupIds.length ?? 0);
}

/** True when the column hosting `targetGroupId` already holds MAX_STACK_DEPTH
 *  groups (so another vertical split would squeeze them into slivers). */
export function isColumnStackFull(
  rows: readonly GroupLayoutRow[],
  targetGroupId: string,
): boolean {
  const loc = locateGroup(rows, targetGroupId);
  if (!loc) return false;
  return columnDepth(rows[loc.rowIdx], loc.primaryId) >= MAX_STACK_DEPTH;
}

/**
 * Append `newGroupId` to the vertical stack of the column hosting
 * `targetGroupId`. `edge: 'bottom'` lands it at the column's bottom (below
 * every existing member); `edge: 'top'` lands it at the very top, PROMOTING it
 * to the column primary (the previous primary + members slide down). Slot
 * heights are reset to equal. No-op (returns the same array reference) when the
 * target can't be located or the column is already at MAX_STACK_DEPTH.
 */
export function addGroupToColumnStack(
  rows: readonly GroupLayoutRow[],
  targetGroupId: string,
  newGroupId: string,
  edge: VerticalEdge,
): GroupLayoutRow[] {
  const loc = locateGroup(rows, targetGroupId);
  if (!loc) return rows as GroupLayoutRow[];
  const row = rows[loc.rowIdx];
  if (columnDepth(row, loc.primaryId) >= MAX_STACK_DEPTH) return rows as GroupLayoutRow[];

  const existing = row.cellStacks?.[loc.primaryId];
  const belowPrimary = existing?.groupIds ?? [];

  // Members below the (possibly new) primary, in visual order.
  let primaryId: string;
  let members: string[];
  if (edge === 'bottom') {
    primaryId = loc.primaryId;
    members = [...belowPrimary, newGroupId];
  } else {
    // 'top' — the dropped group becomes the column primary.
    primaryId = newGroupId;
    members = [loc.primaryId, ...belowPrimary];
  }

  const slots = members.length + 1; // primary + members
  const nextStack: GroupCellStack = {
    groupIds: members,
    heights: equalizeWidths(slots),
  };

  const nextRows = rows.map((rr, i) => {
    if (i !== loc.rowIdx) return rr;
    const groupIdsCol = [...rr.groupIds];
    groupIdsCol[loc.colIdx] = primaryId;
    const cellStacks: Record<string, GroupCellStack> = { ...(rr.cellStacks ?? {}) };
    // Re-key on a 'top' promotion: the old primary no longer heads a stack.
    if (primaryId !== loc.primaryId) delete cellStacks[loc.primaryId];
    cellStacks[primaryId] = nextStack;
    return { ...rr, groupIds: groupIdsCol, cellStacks };
  });
  return nextRows;
}

/** Set the slot heights of the column headed by `primaryId`. `heights` must be
 *  length `stack.groupIds.length + 1` (primary + members); it's normalized to
 *  sum 1. No-op when the column has no stack or the length mismatches. */
export function setColumnStackHeights(
  rows: readonly GroupLayoutRow[],
  primaryId: string,
  heights: readonly number[],
): GroupLayoutRow[] {
  let touched = false;
  const next = rows.map((row) => {
    const stack = row.cellStacks?.[primaryId];
    if (!stack) return row;
    if (heights.length !== stack.groupIds.length + 1) return row;
    touched = true;
    return {
      ...row,
      cellStacks: {
        ...row.cellStacks,
        [primaryId]: { ...stack, heights: normalizeWidths(heights) },
      },
    };
  });
  return touched ? next : (rows as GroupLayoutRow[]);
}

/**
 * Reconcile every row's column stacks against the set of still-live group ids.
 *
 *  - A stacked member that died is dropped from its stack.
 *  - A column primary that died is REPLACED by the first surviving member of
 *    its stack (promotion), with the remaining members re-stacked under it and
 *    surviving slot heights renormalized. The column's `groupIds[colIdx]` is
 *    rewritten to the new primary.
 *  - A column whose every member died keeps its (dead) primary id in
 *    `groupIds[colIdx]` so the caller's existing column/row pruning drops the
 *    column and renormalizes widths — this function never touches widths/rows.
 *  - Empty stacks are removed; rows with no stacks get `cellStacks: undefined`.
 *
 * Returns the reconciled rows plus a `changed` flag (false ⇒ same reference, so
 * callers can skip a state write).
 */
export function reconcileCellStacks(
  rows: readonly GroupLayoutRow[],
  liveGroupIds: ReadonlySet<string>,
): { rows: GroupLayoutRow[]; changed: boolean } {
  let changed = false;
  const nextRows = rows.map((row) => {
    if (!row.cellStacks || Object.keys(row.cellStacks).length === 0) return row;
    const nextGroupIds = [...row.groupIds];
    const nextStacks: Record<string, GroupCellStack> = {};
    let rowChanged = false;

    for (let c = 0; c < row.groupIds.length; c++) {
      const primary = row.groupIds[c];
      const stack = row.cellStacks[primary];
      if (!stack) continue;

      // Members in visual order, paired with their slot heights.
      const members = [primary, ...stack.groupIds];
      const heights =
        stack.heights.length === members.length
          ? stack.heights
          : equalizeWidths(members.length);
      const survivors: string[] = [];
      const survivorHeights: number[] = [];
      members.forEach((m, i) => {
        if (liveGroupIds.has(m)) {
          survivors.push(m);
          survivorHeights.push(heights[i]);
        }
      });

      if (survivors.length === members.length) {
        // Nothing died in this column — keep the stack verbatim.
        nextStacks[primary] = stack;
        continue;
      }
      rowChanged = true;

      if (survivors.length === 0) {
        // Whole column dead — leave the dead primary in place for the caller's
        // column pruner to remove; emit no stack entry.
        continue;
      }

      const newPrimary = survivors[0];
      nextGroupIds[c] = newPrimary;
      const rest = survivors.slice(1);
      if (rest.length > 0) {
        nextStacks[newPrimary] = {
          groupIds: rest,
          heights: normalizeWidths(survivorHeights),
        };
      }
      // rest.length === 0 ⇒ column collapsed to a single live group, no stack.
    }

    if (!rowChanged) return row;
    changed = true;
    const cellStacks = Object.keys(nextStacks).length > 0 ? nextStacks : undefined;
    return { ...row, groupIds: nextGroupIds, cellStacks };
  });

  return changed ? { rows: nextRows, changed } : { rows: rows as GroupLayoutRow[], changed };
}

/** Drop `cellStacks` entries whose primary key isn't among `keepPrimaries`.
 *  Used when the caller prunes dead columns from `groupIds` and must keep the
 *  stacks map in sync. Returns undefined when nothing survives. */
export function pickCellStacks(
  cellStacks: Record<string, GroupCellStack> | undefined,
  keepPrimaries: readonly string[],
): Record<string, GroupCellStack> | undefined {
  if (!cellStacks) return undefined;
  const allow = new Set(keepPrimaries);
  const out: Record<string, GroupCellStack> = {};
  for (const [primary, stack] of Object.entries(cellStacks)) {
    if (allow.has(primary)) out[primary] = stack;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
