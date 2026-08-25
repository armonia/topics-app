/**
 * Stacking pane groups inside one grid column: where a new group lands
 * relative to the target, the depth cap, and the heights of the stack.
 *
 * @covers LAYOUT-01
 */
import { describe, it, expect } from 'bun:test';
import type { GroupLayoutRow } from '../../types';
import {
  rowGroupIds,
  allGroupIdsInRows,
  locateGroup,
  columnDepth,
  isColumnStackFull,
  addGroupToColumnStack,
  setColumnStackHeights,
  reconcileCellStacks,
  pickCellStacks,
} from './groupLayoutStacks';
import { MAX_STACK_DEPTH } from './constants';

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const row = (groupIds: string[], cellStacks?: GroupLayoutRow['cellStacks']): GroupLayoutRow => ({
  groupIds,
  widths: groupIds.map(() => 1 / groupIds.length),
  ...(cellStacks ? { cellStacks } : {}),
});

// A column 'A' filled to exactly MAX_STACK_DEPTH (primary + MAX_STACK_DEPTH-1
// members). Built from the constant so the fullness tests track it instead of
// hardcoding a number that drifts when the cap changes.
const LAST_FULL_MEMBER = `A${MAX_STACK_DEPTH}`;
const fullStackRow = (): GroupLayoutRow => {
  const members = Array.from({ length: MAX_STACK_DEPTH - 1 }, (_, i) => `A${i + 2}`);
  const heights = Array.from({ length: MAX_STACK_DEPTH }, () => 1 / MAX_STACK_DEPTH);
  return row(['A'], { A: { groupIds: members, heights } });
};

describe('rowGroupIds / allGroupIdsInRows', () => {
  it('lists primaries then stacked members in visual order', () => {
    const r = row(['A', 'B'], { A: { groupIds: ['A2', 'A3'], heights: [0.34, 0.33, 0.33] } });
    expect(rowGroupIds(r)).toEqual(['A', 'A2', 'A3', 'B']);
  });
  it('flattens across rows', () => {
    const rows = [row(['A'], { A: { groupIds: ['A2'], heights: [0.5, 0.5] } }), row(['B', 'C'])];
    expect(allGroupIdsInRows(rows)).toEqual(['A', 'A2', 'B', 'C']);
  });
});

describe('locateGroup', () => {
  const rows = [row(['A', 'B'], { B: { groupIds: ['B2'], heights: [0.5, 0.5] } })];
  it('finds a primary', () => {
    expect(locateGroup(rows, 'A')).toEqual({ rowIdx: 0, colIdx: 0, primaryId: 'A', isPrimary: true });
  });
  it('finds a stacked member, reporting its column primary', () => {
    expect(locateGroup(rows, 'B2')).toEqual({ rowIdx: 0, colIdx: 1, primaryId: 'B', isPrimary: false });
  });
  it('returns null when absent', () => {
    expect(locateGroup(rows, 'Z')).toBeNull();
  });
});

describe('columnDepth / isColumnStackFull', () => {
  it('counts primary + members', () => {
    const r = row(['A'], { A: { groupIds: ['A2', 'A3'], heights: [0.34, 0.33, 0.33] } });
    expect(columnDepth(r, 'A')).toBe(3);
    expect(columnDepth(r, 'missing')).toBe(1);
  });
  it('reports full at MAX_STACK_DEPTH', () => {
    const r = fullStackRow();
    expect(columnDepth(r, 'A')).toBe(MAX_STACK_DEPTH);
    expect(isColumnStackFull([r], 'A')).toBe(true);
    expect(isColumnStackFull([r], LAST_FULL_MEMBER)).toBe(true); // a member reports its column's fullness
  });
  it('is not full one below MAX_STACK_DEPTH', () => {
    const r = row(['A'], { A: { groupIds: ['A2'], heights: [0.5, 0.5] } });
    expect(isColumnStackFull([r], 'A')).toBe(false);
  });
});

describe('addGroupToColumnStack — bottom', () => {
  it('initializes a stack under a plain column primary', () => {
    const rows = [row(['A', 'B'])];
    const next = addGroupToColumnStack(rows, 'A', 'NEW', 'bottom');
    expect(next[0].groupIds).toEqual(['A', 'B']); // siblings untouched
    expect(next[0].cellStacks?.A.groupIds).toEqual(['NEW']);
    expect(next[0].cellStacks?.A.heights.length).toBe(2);
    expect(sum(next[0].cellStacks!.A.heights)).toBeCloseTo(1, 6);
  });
  it('inserts directly UNDER the target primary (adjacent, not at the column bottom)', () => {
    const rows = [row(['A'], { A: { groupIds: ['A2'], heights: [0.5, 0.5] } })];
    const next = addGroupToColumnStack(rows, 'A', 'A3', 'bottom');
    expect(next[0].cellStacks?.A.groupIds).toEqual(['A3', 'A2']);
    expect(next[0].cellStacks?.A.heights.length).toBe(3);
  });
  it('appends after the LAST stacked member when it is the target', () => {
    const rows = [row(['A'], { A: { groupIds: ['A2'], heights: [0.5, 0.5] } })];
    const next = addGroupToColumnStack(rows, 'A2', 'A3', 'bottom');
    expect(next[0].cellStacks?.A.groupIds).toEqual(['A2', 'A3']);
  });
  it('inserts directly BELOW a middle member of a deep stack (the preview promise)', () => {
    const rows = [row(['A'], { A: { groupIds: ['A2', 'A3'], heights: [0.34, 0.33, 0.33] } })];
    const next = addGroupToColumnStack(rows, 'A2', 'NEW', 'bottom');
    expect(next[0].cellStacks?.A.groupIds).toEqual(['A2', 'NEW', 'A3']);
  });
  it('does not mutate the input', () => {
    const rows = [row(['A'])];
    const snapshot = JSON.stringify(rows);
    addGroupToColumnStack(rows, 'A', 'NEW', 'bottom');
    expect(JSON.stringify(rows)).toBe(snapshot);
  });
  it('no-ops at MAX_STACK_DEPTH', () => {
    const rows = [fullStackRow()];
    expect(addGroupToColumnStack(rows, 'A', 'OVERFLOW', 'bottom')).toBe(rows);
  });
  it('no-ops on a missing target', () => {
    const rows = [row(['A'])];
    expect(addGroupToColumnStack(rows, 'Z', 'NEW', 'bottom')).toBe(rows);
  });
});

describe('addGroupToColumnStack — top', () => {
  it('on the primary: promotes the new group and slides the old one down', () => {
    const rows = [row(['A', 'B'])];
    const next = addGroupToColumnStack(rows, 'A', 'NEW', 'top');
    expect(next[0].groupIds).toEqual(['NEW', 'B']);
    expect(next[0].cellStacks?.NEW.groupIds).toEqual(['A']);
    expect(next[0].cellStacks?.A).toBeUndefined();
  });
  it('on a stacked member: inserts directly ABOVE it, primary unchanged', () => {
    const rows = [row(['A'], { A: { groupIds: ['A2'], heights: [0.5, 0.5] } })];
    const next = addGroupToColumnStack(rows, 'A2', 'NEW', 'top');
    expect(next[0].groupIds).toEqual(['A']);
    expect(next[0].cellStacks?.A.groupIds).toEqual(['NEW', 'A2']);
  });
  it('above a middle member of a deep stack lands adjacent', () => {
    const rows = [row(['A'], { A: { groupIds: ['A2', 'A3'], heights: [0.34, 0.33, 0.33] } })];
    const next = addGroupToColumnStack(rows, 'A3', 'NEW', 'top');
    expect(next[0].cellStacks?.A.groupIds).toEqual(['A2', 'NEW', 'A3']);
  });
});

describe('setColumnStackHeights', () => {
  it('updates and normalizes heights', () => {
    const rows = [row(['A'], { A: { groupIds: ['A2'], heights: [0.5, 0.5] } })];
    const next = setColumnStackHeights(rows, 'A', [3, 1]);
    expect(next[0].cellStacks?.A.heights).toEqual([0.75, 0.25]);
  });
  it('no-ops on length mismatch', () => {
    const rows = [row(['A'], { A: { groupIds: ['A2'], heights: [0.5, 0.5] } })];
    expect(setColumnStackHeights(rows, 'A', [0.3, 0.3, 0.4])).toBe(rows);
  });
  it('no-ops when no stack', () => {
    const rows = [row(['A'])];
    expect(setColumnStackHeights(rows, 'A', [1])).toBe(rows);
  });
});

describe('reconcileCellStacks', () => {
  it('returns the same reference when nothing died', () => {
    const rows = [row(['A'], { A: { groupIds: ['A2'], heights: [0.5, 0.5] } })];
    const res = reconcileCellStacks(rows, new Set(['A', 'A2']));
    expect(res.changed).toBe(false);
    expect(res.rows).toBe(rows);
  });
  it('drops a dead stacked member', () => {
    const rows = [row(['A'], { A: { groupIds: ['A2', 'A3'], heights: [0.34, 0.33, 0.33] } })];
    const res = reconcileCellStacks(rows, new Set(['A', 'A3']));
    expect(res.changed).toBe(true);
    expect(res.rows[0].cellStacks?.A.groupIds).toEqual(['A3']);
    expect(res.rows[0].cellStacks?.A.heights.length).toBe(2);
    expect(sum(res.rows[0].cellStacks!.A.heights)).toBeCloseTo(1, 6);
  });
  it('collapses the stack when only the primary survives', () => {
    const rows = [row(['A'], { A: { groupIds: ['A2'], heights: [0.5, 0.5] } })];
    const res = reconcileCellStacks(rows, new Set(['A']));
    expect(res.rows[0].cellStacks).toBeUndefined();
    expect(res.rows[0].groupIds).toEqual(['A']);
  });
  it('promotes the first survivor when the primary dies', () => {
    const rows = [row(['A', 'B'], { A: { groupIds: ['A2', 'A3'], heights: [0.34, 0.33, 0.33] } })];
    const res = reconcileCellStacks(rows, new Set(['A2', 'A3', 'B']));
    expect(res.rows[0].groupIds).toEqual(['A2', 'B']);
    expect(res.rows[0].cellStacks?.A2.groupIds).toEqual(['A3']);
    expect(res.rows[0].cellStacks?.A).toBeUndefined();
  });
  it('leaves a fully-dead column primary for the caller to prune', () => {
    const rows = [row(['A', 'B'], { A: { groupIds: ['A2'], heights: [0.5, 0.5] } })];
    const res = reconcileCellStacks(rows, new Set(['B']));
    // A's column is fully dead — primary id stays (so column pruning drops it),
    // no stack entry emitted.
    expect(res.rows[0].groupIds).toEqual(['A', 'B']);
    expect(res.rows[0].cellStacks).toBeUndefined();
  });
});

describe('pickCellStacks', () => {
  it('keeps only stacks whose primary survives', () => {
    const stacks = {
      A: { groupIds: ['A2'], heights: [0.5, 0.5] },
      B: { groupIds: ['B2'], heights: [0.5, 0.5] },
    };
    expect(pickCellStacks(stacks, ['A'])).toEqual({ A: { groupIds: ['A2'], heights: [0.5, 0.5] } });
    expect(pickCellStacks(stacks, ['Z'])).toBeUndefined();
    expect(pickCellStacks(undefined, ['A'])).toBeUndefined();
  });
});
