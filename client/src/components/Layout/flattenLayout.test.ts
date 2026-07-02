import { describe, it, expect } from 'bun:test';
import type { GroupLayoutRow, PanelGridRow } from '../../types';
import { flattenGroupRows, flattenGridRows } from './flattenLayout';
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

const gridRow = (
  itemKeys: string[],
  cellStacks?: PanelGridRow['cellStacks'],
): PanelGridRow => ({
  itemKeys,
  widths: itemKeys.map(() => 1 / itemKeys.length),
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

  it('returns null when already flat (single row, no stacks) so hosts hide the menu entry', () => {
    expect(flattenGroupRows([groupRow(['A', 'B', 'C'])])).toBeNull();
    expect(flattenGroupRows([])).toBeNull();
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

describe('flattenGridRows', () => {
  it('walks itemKeys-then-stack-items per row and never touches soloCells keys', () => {
    const rows = [
      gridRow(['standalone', 'solo:x'], {
        standalone: { items: ['solo:y'], heights: [0.5, 0.5] },
      }),
      gridRow(['solo:z']),
    ];
    const res = flattenGridRows(rows);
    expect(res).not.toBeNull();
    expect(res!.rows.length).toBe(1);
    // Stack members keep their EXISTING keys — promoted to top-level cells,
    // no re-keying (soloCells is not consulted or rewritten).
    expect(res!.rows[0].itemKeys).toEqual(['standalone', 'solo:y', 'solo:x', 'solo:z']);
    expect(res!.rows[0].widths).toEqual(equalizeWidths(4));
    expect('cellStacks' in res!.rows[0]).toBe(false);
    expect(res!.rowHeights).toEqual([1]);
  });

  it('returns null when already flat (single row, no stacks)', () => {
    expect(flattenGridRows([gridRow(['standalone', 'solo:a'])])).toBeNull();
    expect(flattenGridRows([])).toBeNull();
  });

  it('a single row with a stack flattens (not null)', () => {
    const rows = [
      gridRow(['standalone'], { standalone: { items: ['solo:a'], heights: [0.7, 0.3] } }),
    ];
    const res = flattenGridRows(rows);
    expect(res).not.toBeNull();
    expect(res!.rows[0].itemKeys).toEqual(['standalone', 'solo:a']);
    expect(res!.rowHeights).toEqual([1]);
  });

  it('dedups duplicate/dead keys first-occurrence', () => {
    const rows = [gridRow(['standalone', 'solo:a']), gridRow(['solo:a', 'solo:dead'])];
    const res = flattenGridRows(rows);
    expect(res).not.toBeNull();
    // 'solo:dead' is kept (liveness pruning is the sync effect's job), the
    // duplicate 'solo:a' is not.
    expect(res!.rows[0].itemKeys).toEqual(['standalone', 'solo:a', 'solo:dead']);
  });

  it('chunks >MAX_COLS_PER_ROW cells into multiple rows', () => {
    const n = MAX_COLS_PER_ROW + 1;
    const keys = Array.from({ length: n }, (_, i) => `solo:k${i}`);
    const rows = [gridRow(keys.slice(0, 20)), gridRow(keys.slice(20))];
    const res = flattenGridRows(rows);
    expect(res).not.toBeNull();
    expect(res!.rows.length).toBe(2);
    expect(res!.rows[0].itemKeys.length).toBe(MAX_COLS_PER_ROW);
    expect(res!.rows[1].itemKeys.length).toBe(1);
    expect(res!.rowHeights).toEqual(equalizeWidths(2));
  });
});
