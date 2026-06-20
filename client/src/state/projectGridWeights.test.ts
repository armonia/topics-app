import { describe, test, expect } from 'bun:test';
import { computeProjectGridWeight, setProjectGridWeight, getProjectGridWeight, clearProjectGridWeight } from './projectGridWeights';
import type { GroupLayoutRow } from '../types';

const row = (groupIds: string[], cellStacks?: GroupLayoutRow['cellStacks']): GroupLayoutRow => ({
  groupIds,
  widths: groupIds.map(() => 1 / groupIds.length),
  ...(cellStacks ? { cellStacks } : {}),
});

describe('computeProjectGridWeight', () => {
  test('empty / nullish layout → a single unsplit cell (weight 1×1)', () => {
    expect(computeProjectGridWeight(undefined)).toEqual({ cols: 1, rows: 1 });
    expect(computeProjectGridWeight(null)).toEqual({ cols: 1, rows: 1 });
    expect(computeProjectGridWeight([])).toEqual({ cols: 1, rows: 1 });
  });

  test('single row of 3 columns → cols 3, rows 1', () => {
    expect(computeProjectGridWeight([row(['a', 'b', 'c'])])).toEqual({ cols: 3, rows: 1 });
  });

  test('three stacked rows of 1 column → cols 1, rows 3', () => {
    expect(computeProjectGridWeight([row(['a']), row(['b']), row(['c'])])).toEqual({ cols: 1, rows: 3 });
  });

  test('cols = the WIDEST row, not the first', () => {
    expect(computeProjectGridWeight([row(['a']), row(['b', 'c', 'd'])])).toEqual({ cols: 3, rows: 2 });
  });

  test('a vertical sub-stack (cellStacks) adds to the row depth', () => {
    // row with 2 columns; column "a" has a 2-deep stack under it (2 extra groups)
    // → that row is 3 leaves tall (primary + 2), cols = 2.
    const r = row(['a', 'b'], { a: { groupIds: ['a2', 'a3'], heights: [0.5, 0.5] } });
    expect(computeProjectGridWeight([r])).toEqual({ cols: 2, rows: 3 });
  });

  test('row depth = the DEEPEST column in that row', () => {
    const r = row(['a', 'b'], {
      a: { groupIds: ['a2'], heights: [1] },          // depth 2
      b: { groupIds: ['b2', 'b3', 'b4'], heights: [] }, // depth 4
    });
    // two rows: this deep one (depth 4) + a plain single → rows 4 + 1 = 5
    expect(computeProjectGridWeight([r, row(['c'])])).toEqual({ cols: 2, rows: 5 });
  });
});

describe('projectGridWeights registry', () => {
  test('set / get / clear round-trips', () => {
    const path = '/tmp/test-project-xyz';
    expect(getProjectGridWeight(path)).toBeUndefined();
    setProjectGridWeight(path, { cols: 2, rows: 3 });
    expect(getProjectGridWeight(path)).toEqual({ cols: 2, rows: 3 });
    clearProjectGridWeight(path);
    expect(getProjectGridWeight(path)).toBeUndefined();
  });
});
