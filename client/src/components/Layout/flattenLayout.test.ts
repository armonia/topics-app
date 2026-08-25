/**
 * Flattening a nested pane grid into rows of equal height, chunked at the max
 * columns per row, with duplicate pane keys deduped and stacks dissolved.
 *
 * @covers LAYOUT-01
 */
import { describe, it, expect } from 'bun:test';
import type { GroupLayoutRow } from '../../types';
import { flattenGroupRows } from './flattenLayout';
import { equalizeWidths } from './gridWidths';
import { MAX_COLS_PER_ROW } from './constants';

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

const groupRow = (
  groupIds: string[],
  cellStacks?: GroupLayoutRow['cellStacks'],
): GroupLayoutRow => ({
  groupIds,
  widths: groupIds.map(() => 1 / groupIds.length),
  ...(cellStacks ? { cellStacks } : {}),
});

describe('flattenGroupRows', () => {
  it('flattens a nested layout (2 rows, one 2-deep cellStack) into a single row in visual order', () => {
    const rows = [
      groupRow(['A', 'B'], { A: { groupIds: ['A2', 'A3'], heights: [0.34, 0.33, 0.33] } }),
      groupRow(['C']),
    ];
    const res = flattenGroupRows(rows);
    expect(res).not.toBeNull();
    expect(res!.rows.length).toBe(1);
    // allGroupIdsInRows order: each column's primary then its stack, L→R per row.
    expect(res!.rows[0].groupIds).toEqual(['A', 'A2', 'A3', 'B', 'C']);
    // Widths are EXACTLY equalizeWidths(n) (no float drift) and sum to 1.
    expect(res!.rows[0].widths).toEqual(equalizeWidths(5));
    expect(sum(res!.rows[0].widths)).toBeCloseTo(1, 10);
    // Stacks dissolve — no cellStacks key on the output row.
    expect('cellStacks' in res!.rows[0]).toBe(false);
    expect(res!.rowHeights).toEqual([1]);
  });

  it('appends liveGroupIds missing from rows (defensive union against the sync-effect heal)', () => {
    const rows = [groupRow(['A']), groupRow(['B'])];
    const res = flattenGroupRows(rows, ['A', 'B', 'GHOST']);
    expect(res).not.toBeNull();
    expect(res!.rows[0].groupIds).toEqual(['A', 'B', 'GHOST']);
    expect(res!.rows[0].widths).toEqual(equalizeWidths(3));
  });

  it('chunks >MAX_COLS_PER_ROW leaves into multiple rows of equal heights', () => {
    const n = MAX_COLS_PER_ROW + 1; // 33
    const ids = Array.from({ length: n }, (_, i) => `G${i}`);
    // Spread across two nested rows so it's not "already flat".
    const rows = [groupRow(ids.slice(0, 17)), groupRow(ids.slice(17))];
    const res = flattenGroupRows(rows);
    expect(res).not.toBeNull();
    expect(res!.rows.length).toBe(2);
    expect(res!.rows[0].groupIds.length).toBe(MAX_COLS_PER_ROW);
    expect(res!.rows[1].groupIds.length).toBe(1);
    expect(res!.rows[0].groupIds).toEqual(ids.slice(0, MAX_COLS_PER_ROW));
    expect(res!.rows[1].groupIds).toEqual(ids.slice(MAX_COLS_PER_ROW));
    expect(res!.rows[0].widths).toEqual(equalizeWidths(MAX_COLS_PER_ROW));
    expect(res!.rows[1].widths).toEqual(equalizeWidths(1));
    expect(res!.rowHeights).toEqual(equalizeWidths(2));
  });

  it('returns null when already flat (single row, EQUAL widths, no stacks) so hosts hide the menu entry', () => {
    expect(flattenGroupRows([groupRow(['A', 'B', 'C'])])).toBeNull();
    expect(flattenGroupRows([])).toBeNull();
  });

  it('re-equalises a project single row whose widths were dragged to custom values', () => {
    const rows = [{ groupIds: ['A', 'B'], widths: [0.75, 0.25] }];
    const res = flattenGroupRows(rows);
    expect(res).not.toBeNull();
    expect(res!.rows.length).toBe(1);
    expect(res!.rows[0].groupIds).toEqual(['A', 'B']);
    expect(res!.rows[0].widths).toEqual(equalizeWidths(2));
  });

  it('a single row WITH a stack is NOT flat — the stack dissolves into columns', () => {
    const rows = [groupRow(['A', 'B'], { B: { groupIds: ['B2'], heights: [0.5, 0.5] } })];
    const res = flattenGroupRows(rows);
    expect(res).not.toBeNull();
    expect(res!.rows[0].groupIds).toEqual(['A', 'B', 'B2']);
    expect(res!.rows[0].cellStacks).toBeUndefined();
    expect(res!.rowHeights).toEqual([1]);
  });

  it('dedups duplicate keys first-occurrence (across rows and vs liveGroupIds)', () => {
    const rows = [groupRow(['A', 'B']), groupRow(['B', 'C'])];
    const res = flattenGroupRows(rows, ['C', 'A']);
    expect(res).not.toBeNull();
    expect(res!.rows[0].groupIds).toEqual(['A', 'B', 'C']);
    expect(res!.rows[0].widths).toEqual(equalizeWidths(3));
  });

  it('an empty cellStacks entry (no members) does not block the null (already-flat) branch', () => {
    const rows = [groupRow(['A'], { A: { groupIds: [], heights: [1] } })];
    expect(flattenGroupRows(rows)).toBeNull();
  });
});
