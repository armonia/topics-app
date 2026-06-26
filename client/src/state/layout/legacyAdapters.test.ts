import { test, expect, describe } from 'bun:test';
import { gridRowsToTree, groupRowsToTree } from './legacyAdapters';
import { leafIds, computeRects, isLeaf, isSplit, type LayoutNode, type SplitNode, type LeafRect } from './layoutTree';
import type { PanelGridRow, GroupLayoutRow } from '../../types';

const asSplit = (n: LayoutNode): SplitNode => {
  if (!isSplit(n)) throw new Error('expected split');
  return n;
};
const RECT = { x: 0, y: 0, width: 100, height: 100 };
const rectOf = (rects: LeafRect[], id: string): LeafRect => rects.find((r) => r.id === id)!;

describe('gridRowsToTree (standalone PanelGrid)', () => {
  test('single pane collapses to a bare leaf', () => {
    const rows: PanelGridRow[] = [{ itemKeys: ['a'], widths: [1] }];
    const t = gridRowsToTree(rows, [1]);
    expect(isLeaf(t)).toBe(true);
    expect(leafIds(t)).toEqual(['a']);
  });

  test('two columns → one row-split with the same widths', () => {
    const rows: PanelGridRow[] = [{ itemKeys: ['a', 'b'], widths: [0.3, 0.7] }];
    const t = gridRowsToTree(rows, [1]);
    expect(asSplit(t).dir).toBe('row');
    expect(leafIds(t)).toEqual(['a', 'b']);
    const rects = computeRects(t, RECT);
    expect(rectOf(rects, 'a').width).toBeCloseTo(30, 5);
    expect(rectOf(rects, 'b').width).toBeCloseTo(70, 5);
  });

  test('two rows → one col-split with rowHeights', () => {
    const rows: PanelGridRow[] = [
      { itemKeys: ['a'], widths: [1] },
      { itemKeys: ['b'], widths: [1] },
    ];
    const t = gridRowsToTree(rows, [0.4, 0.6]);
    expect(asSplit(t).dir).toBe('col');
    const rects = computeRects(t, RECT);
    expect(rectOf(rects, 'a').height).toBeCloseTo(40, 5);
    expect(rectOf(rects, 'b').height).toBeCloseTo(60, 5);
  });

  test('a cell sub-stack nests a col-split under its column (heights include primary)', () => {
    const rows: PanelGridRow[] = [
      {
        itemKeys: ['a', 'b'],
        widths: [0.5, 0.5],
        cellStacks: { a: { items: ['c'], heights: [0.6, 0.4] } }, // [primary a, c]
      },
    ];
    const t = gridRowsToTree(rows, [1]);
    expect(leafIds(t)).toEqual(['a', 'c', 'b']);
    const rects = computeRects(t, RECT);
    // a: top-left half, height 60; c: below a, height 40; b: full-height right half
    expect(rectOf(rects, 'a')).toMatchObject({ x: 0, y: 0, width: 50 });
    expect(rectOf(rects, 'a').height).toBeCloseTo(60, 5);
    expect(rectOf(rects, 'c').height).toBeCloseTo(40, 5);
    expect(rectOf(rects, 'c').y).toBeCloseTo(60, 5);
    expect(rectOf(rects, 'b')).toMatchObject({ x: 50, y: 0, width: 50, height: 100 });
  });

  test('corrupt stack heights (wrong length) fall back to an equal split', () => {
    const rows: PanelGridRow[] = [
      { itemKeys: ['a'], widths: [1], cellStacks: { a: { items: ['c'], heights: [1] } } }, // len 1, need 2
    ];
    const t = gridRowsToTree(rows, [1]);
    const rects = computeRects(t, RECT);
    expect(rectOf(rects, 'a').height).toBeCloseTo(50, 5);
    expect(rectOf(rects, 'c').height).toBeCloseTo(50, 5);
  });

  test('area is conserved across a mixed layout', () => {
    const rows: PanelGridRow[] = [
      { itemKeys: ['a', 'b'], widths: [0.4, 0.6], cellStacks: { b: { items: ['d'], heights: [0.5, 0.5] } } },
      { itemKeys: ['e'], widths: [1] },
    ];
    const t = gridRowsToTree(rows, [0.7, 0.3]);
    const area = computeRects(t, RECT).reduce((s, r) => s + r.width * r.height, 0);
    expect(area).toBeCloseTo(100 * 100, 3);
    expect(leafIds(t).sort()).toEqual(['a', 'b', 'd', 'e']);
  });
});

describe('groupRowsToTree (project GroupLayout)', () => {
  test('two columns with a sub-stack mirror the grid adapter (groupIds)', () => {
    const rows: GroupLayoutRow[] = [
      {
        groupIds: ['g1', 'g2'],
        widths: [0.5, 0.5],
        cellStacks: { g1: { groupIds: ['g3'], heights: [0.7, 0.3] } },
      },
    ];
    const t = groupRowsToTree(rows, [1]);
    expect(leafIds(t)).toEqual(['g1', 'g3', 'g2']);
    const rects = computeRects(t, RECT);
    expect(rectOf(rects, 'g1').height).toBeCloseTo(70, 5);
    expect(rectOf(rects, 'g3').height).toBeCloseTo(30, 5);
    expect(rectOf(rects, 'g2')).toMatchObject({ x: 50, width: 50, height: 100 });
  });

  test('single group collapses to a leaf', () => {
    const t = groupRowsToTree([{ groupIds: ['only'], widths: [1] }], [1]);
    expect(isLeaf(t)).toBe(true);
    expect(leafIds(t)).toEqual(['only']);
  });
});
