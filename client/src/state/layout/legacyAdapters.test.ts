import { test, expect, describe } from 'bun:test';
import { gridRowsToTree, groupRowsToTree, treeToGridRows, treeToGroupRows } from './legacyAdapters';
import { leafIds, computeRects, isLeaf, isSplit, splitLeaf, type LayoutNode, type SplitNode, type LeafRect } from './layoutTree';
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

describe('round-trip legacy → tree → legacy (forward-adapter fidelity)', () => {
  const approxGrid = (a: PanelGridRow[], b: PanelGridRow[]) => {
    expect(a.length).toBe(b.length);
    a.forEach((row, i) => {
      expect(row.itemKeys).toEqual(b[i].itemKeys);
      expect(row.widths.length).toBe(b[i].widths.length);
      row.widths.forEach((w, j) => expect(w).toBeCloseTo(b[i].widths[j], 5));
      const as = row.cellStacks ?? {};
      const bs = b[i].cellStacks ?? {};
      expect(Object.keys(as).sort()).toEqual(Object.keys(bs).sort());
      for (const k of Object.keys(as)) {
        expect(as[k].items).toEqual(bs[k].items);
        as[k].heights.forEach((h, j) => expect(h).toBeCloseTo(bs[k].heights[j], 5));
      }
    });
  };

  const GRID_FIXTURES: { rows: PanelGridRow[]; heights: number[] }[] = [
    { rows: [{ itemKeys: ['a'], widths: [1] }], heights: [1] },
    { rows: [{ itemKeys: ['a', 'b'], widths: [0.3, 0.7] }], heights: [1] },
    { rows: [{ itemKeys: ['a'], widths: [1] }, { itemKeys: ['b'], widths: [1] }], heights: [0.4, 0.6] },
    {
      rows: [
        { itemKeys: ['a', 'b'], widths: [0.5, 0.5], cellStacks: { a: { items: ['c'], heights: [0.6, 0.4] } } },
        { itemKeys: ['d', 'e', 'f'], widths: [0.2, 0.3, 0.5] },
      ],
      heights: [0.7, 0.3],
    },
  ];

  test('grid layouts survive the round-trip with identical keys + weights', () => {
    for (const fx of GRID_FIXTURES) {
      const back = treeToGridRows(gridRowsToTree(fx.rows, fx.heights));
      approxGrid(back.rows, fx.rows);
      expect(back.rowHeights.length).toBe(fx.heights.length);
      back.rowHeights.forEach((h, i) => expect(h).toBeCloseTo(fx.heights[i], 5));
    }
  });

  test('project group layout survives the round-trip', () => {
    const rows: GroupLayoutRow[] = [
      { groupIds: ['g1', 'g2'], widths: [0.4, 0.6], cellStacks: { g2: { groupIds: ['g3', 'g4'], heights: [0.5, 0.3, 0.2] } } },
    ];
    const back = treeToGroupRows(groupRowsToTree(rows, [1]));
    expect(back.rows[0].groupIds).toEqual(['g1', 'g2']);
    back.rows[0].widths.forEach((w, j) => expect(w).toBeCloseTo([0.4, 0.6][j], 5));
    expect(back.rows[0].cellStacks!.g2.groupIds).toEqual(['g3', 'g4']);
    back.rows[0].cellStacks!.g2.heights.forEach((h, j) => expect(h).toBeCloseTo([0.5, 0.3, 0.2][j], 5));
  });

  test('a deeper-than-legacy tree flattens defensively (never throws)', () => {
    // Build a tree the legacy model cannot hold: a column split, then split a leaf
    // AGAIN on the cross axis → depth 3 inside one column.
    let t: LayoutNode = gridRowsToTree([{ itemKeys: ['a', 'b'], widths: [0.5, 0.5] }], [1]);
    t = splitLeaf(t, 'b', 'bottom', 'c'); // b → col[b,c]
    t = splitLeaf(t, 'c', 'right', 'd'); // c → row[c,d] nested in the col
    const back = treeToGridRows(t);
    expect(back.rows.length).toBeGreaterThan(0);
    // No throw, and every original-ish key is still referenced somewhere.
    const keys = back.rows.flatMap((r) => [...r.itemKeys, ...Object.values(r.cellStacks ?? {}).flatMap((s) => s.items)]);
    expect(keys).toContain('a');
    expect(keys).toContain('b');
  });
});
