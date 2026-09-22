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
import { MAX_COLS_PER_ROW, MAX_ROWS, MAX_STACK_DEPTH } from './constants';
import { normalizeWidths, equalizeWidths, splitColumnWidths } from './gridWidths';

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
 * Insert `newGroupId` into the vertical stack of the column hosting
 * `targetGroupId`, ADJACENT to the target member: `edge: 'bottom'` lands it
 * directly BELOW the target, `edge: 'top'` directly ABOVE it. The split
 * preview is painted on the target member's own cell, so adjacency is what
 * the gesture promises — inserting at the column's absolute ends (the old
 * behavior) landed the pane cells away when the target was a middle member
 * of a deep stack. Landing at visual slot 0 (top of the primary) PROMOTES
 * the new group to column primary (the previous primary + members slide
 * down). The new slot takes HALF of the target's height and every sibling
 * keeps the size it was dragged to: the old `equalizeWidths` reset the whole
 * column to 1/N, so adding a third pane flattened a deliberate 80/20 (and the
 * preview had promised half of the target cell, not 1/N of the column).
 * No-op (returns the same array reference) when the target can't be located
 * or the column is already at MAX_STACK_DEPTH.
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

  // The column in visual order, with the new group spliced in next to the
  // located target. Slot 0 heads the column → whoever ends up there is the
  // (possibly new) primary.
  const visual = [loc.primaryId, ...belowPrimary];
  const targetIdx = visual.indexOf(targetGroupId); // ≥ 0 — locateGroup found it
  const insertAt = edge === 'bottom' ? targetIdx + 1 : targetIdx;

  // Heights BEFORE the splice, so the donor index still lines up with `visual`.
  // A stored array of the wrong length is corrupt persisted state: fall back to
  // an even column rather than mis-assigning somebody else's height.
  const prevHeights =
    existing && existing.heights.length === visual.length
      ? existing.heights
      : equalizeWidths(visual.length);

  visual.splice(insertAt, 0, newGroupId);
  const primaryId = visual[0];
  const members = visual.slice(1);

  const nextStack: GroupCellStack = {
    groupIds: members,
    heights: splitColumnWidths(prevHeights, targetIdx, insertAt),
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

/**
 * Which column container must carry a left/right split preview, or null when
 * the hovered slot is the right place for it.
 *
 * A left/right release always inserts a FULL-HEIGHT column beside the HOST
 * column: `handleSplitGroup` resolves the target through `locateGroup` and
 * writes into `row.groupIds`, the row's only horizontal axis. So on a stacked
 * column the preview painted on a member's own slot promises half a cell and
 * delivers a whole column. Returning the column primary tells the renderer to
 * paint the region on the column container instead, which is exactly the
 * footprint that lands. Only ONE of the two paints per gesture, so the single
 * `data-grid-split-overlay` the e2e tests locate stays single.
 *
 * Only left/right: a top/bottom release really does land adjacent to the
 * target slot, so its half-slot preview is honest.
 */
export function columnSplitPreviewHost(
  row: GroupLayoutRow | undefined,
  targetGroupId: string,
  edge: 'left' | 'right' | 'top' | 'bottom' | 'center',
): string | null {
  if (!row || (edge !== 'left' && edge !== 'right')) return null;
  const loc = locateGroup([row], targetGroupId);
  if (!loc) return null;
  return columnDepth(row, loc.primaryId) > 1 ? loc.primaryId : null;
}

/**
 * Would a full-width row inserted at `gapIdx` (between rows gapIdx and
 * gapIdx+1) actually reshape the tree?
 *
 * The new row lands exactly in the gap, so when the pane in flight is the only
 * pane of the only group of a row TOUCHING that gap, its old row empties and
 * disappears right where the new one appeared: the same tree, redrawn. The
 * band lit up for it all the same.
 *
 * An unknown source (`undefined` size: the drag came from another window, where
 * the drag shelf is empty) answers yes — refusing on a guess kills a gesture
 * that works.
 */
export function rowGapWouldReshape(
  rows: readonly GroupLayoutRow[],
  gapIdx: number,
  sourceGroupId: string | undefined,
  sourceGroupSize: number | undefined,
): boolean {
  if (!sourceGroupId || sourceGroupSize === undefined || sourceGroupSize > 1) return true;
  for (const idx of [gapIdx, gapIdx + 1]) {
    const row = rows[idx];
    if (!row) continue;
    const ids = rowGroupIds(row);
    if (ids.length === 1 && ids[0] === sourceGroupId) return false;
  }
  return true;
}

/**
 * Where `gid`'s own rect sits inside its row: which row, and whether it is the
 * first / last slot of its column. A stacked column's MIDDLE slot touches
 * neither the row's top nor its bottom, so no full-width strip can cover it.
 * null when the group is nowhere in `rows`.
 */
export function slotEdges(
  rows: readonly GroupLayoutRow[],
  gid: string,
): { rowIdx: number; atColumnTop: boolean; atColumnBottom: boolean } | null {
  const loc = locateGroup(rows, gid);
  if (!loc) return null;
  const members = rows[loc.rowIdx].cellStacks?.[loc.primaryId]?.groupIds ?? [];
  return {
    rowIdx: loc.rowIdx,
    atColumnTop: loc.isPrimary,
    atColumnBottom: members.length === 0 ? loc.isPrimary : gid === members[members.length - 1],
  };
}

/**
 * Would a split on `targetGroupId`'s `edge` fit inside the runaway caps, i.e.
 * will the drop actually build it?
 *
 * The caps (`MAX_COLS_PER_ROW`, `MAX_ROWS`, `MAX_STACK_DEPTH`) used to be read
 * only by the drop, which returns without mutating anything when one is hit.
 * The dragover knew nothing of them, so at the cap the band still lit up and
 * the release did nothing: the same "a promised gesture must succeed" law the
 * rest of this system now obeys, broken by silence. This is that question,
 * asked by both sides so they cannot answer differently.
 *
 * The branches mirror `useProjectLayout.handleSplitGroup` line for line:
 * left/right cap the target's HOST row (a stacked member counts its host, which
 * a bare `groupIds.includes` walk would miss), a bare top/bottom caps the
 * target column's stack depth, and a `fullRow` intent caps the row count.
 *
 * A target that cannot be located answers yes: the honest answer is "not mine
 * to refuse", and the drop is the one with the authoritative rows.
 */
export function splitFitsCaps(
  rows: readonly GroupLayoutRow[],
  targetGroupId: string,
  edge: 'left' | 'right' | 'top' | 'bottom',
  fullRow: boolean,
): boolean {
  const vertical = edge === 'top' || edge === 'bottom';
  if (vertical && fullRow) return rows.length < MAX_ROWS;
  const loc = locateGroup(rows, targetGroupId);
  if (!loc) return true;
  if (vertical) return columnDepth(rows[loc.rowIdx], loc.primaryId) < MAX_STACK_DEPTH;
  return rows[loc.rowIdx].groupIds.length < MAX_COLS_PER_ROW;
}
