/**
 * @covers SPLIT-07
 */
import { describe, expect, test } from 'bun:test';
import type { GroupLayoutRow } from '../types';
import { projectSplitMap } from './projectSplitMaps';

describe('the map of a project window (SPLIT-07)', () => {
  test('one cell draws no map', () => {
    expect(projectSplitMap([{ groupIds: ['a'], widths: [1] }], [1], 'a')).toBeUndefined();
  });

  test('a window split in two draws two cells, the active one lit', () => {
    const map = projectSplitMap([{ groupIds: ['a', 'b'], widths: [0.6, 0.4] }], [1], 'b');
    expect(map?.rows).toEqual([[0.6, 0.4]]);
    expect(map?.active).toEqual([0, 1]);
  });

  test('a lone stacked column is drawn as rows, with its heights', () => {
    const rows: GroupLayoutRow[] = [{ groupIds: ['a'], widths: [1], cellStacks: { a: { groupIds: ['b'], heights: [0.7, 0.3] } } }];
    const map = projectSplitMap(rows, [1], 'b');
    expect(map?.rows).toEqual([[1], [1]]);
    expect(map?.rowHeights?.[0]).toBeCloseTo(0.7);
    expect(map?.active).toEqual([1, 0]);
  });

  test('a group stacked beside another column lights its column', () => {
    const rows: GroupLayoutRow[] = [{ groupIds: ['a', 'c'], widths: [0.5, 0.5], cellStacks: { c: { groupIds: ['d'], heights: [0.5, 0.5] } } }];
    expect(projectSplitMap(rows, [1], 'd')?.active).toEqual([0, 1]);
  });
});
