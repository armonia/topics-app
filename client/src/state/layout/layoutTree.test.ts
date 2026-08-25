/**
 * The layout tree itself: constructors, normalization, queries and the
 * rectangle geometry every split and resize is computed from.
 *
 * @covers LAYOUT-01
 */
import { test, expect, describe } from 'bun:test';
import {
  leaf,
  split,
  normalize,
  isSplit,
  isLeaf,
  leafIds,
  computeRects,
  type LayoutNode,
  type SplitNode,
} from './layoutTree';

const asSplit = (n: LayoutNode): SplitNode => {
  if (!isSplit(n)) throw new Error('expected split');
  return n;
};
const weights = (n: LayoutNode): number[] => asSplit(n).children.map((c) => c.weight);

describe('constructors / normalize', () => {
  test('split with explicit weights normalises to sum 1', () => {
    const t = split('row', [leaf('a'), leaf('b'), leaf('c')], [2, 3, 5]);
    expect(weights(t)).toEqual([0.2, 0.3, 0.5]);
  });

  test('equal weights by default', () => {
    const t = split('col', [leaf('a'), leaf('b')]);
    expect(weights(t)).toEqual([0.5, 0.5]);
  });

  test('single-child split collapses to the child', () => {
    const t = normalize({ kind: 'split', dir: 'row', children: [{ weight: 1, node: leaf('only') }] });
    expect(isLeaf(t)).toBe(true);
    expect((t as { id: string }).id).toBe('only');
  });

  test('same-axis nested split is flattened, scaling grandchildren by the child weight', () => {
    // row[ row[a,b]@0.4 , c@0.6 ] → row[a,b,c] with a,b = 0.4*0.5 each, c = 0.6
    const t = normalize({
      kind: 'split',
      dir: 'row',
      children: [
        { weight: 0.4, node: split('row', [leaf('a'), leaf('b')]) },
        { weight: 0.6, node: leaf('c') },
      ],
    });
    expect(isSplit(t)).toBe(true);
    expect(leafIds(t)).toEqual(['a', 'b', 'c']);
    expect(weights(t)[0]).toBeCloseTo(0.2, 6);
    expect(weights(t)[1]).toBeCloseTo(0.2, 6);
    expect(weights(t)[2]).toBeCloseTo(0.6, 6);
  });

  test('cross-axis nested split is preserved', () => {
    const t = split('col', [split('row', [leaf('a'), leaf('b')]), leaf('c')]);
    expect(asSplit(t).dir).toBe('col');
    expect(asSplit(t).children.length).toBe(2);
    expect(leafIds(t)).toEqual(['a', 'b', 'c']);
  });

  test('normalize flattens a multi-level same-axis nest in one pass', () => {
    // row[ row[ row[a,b] , c ] , d ] → row[a,b,c,d]
    const messy = {
      kind: 'split' as const,
      dir: 'row' as const,
      children: [
        {
          weight: 0.5,
          node: split('row', [split('row', [leaf('a'), leaf('b')]), leaf('c')]),
        },
        { weight: 0.5, node: leaf('d') },
      ],
    };
    const r = normalize(messy);
    expect(isSplit(r)).toBe(true);
    expect(asSplit(r).dir).toBe('row');
    expect(asSplit(r).children.every((ch) => isLeaf(ch.node))).toBe(true);
    expect(leafIds(r)).toEqual(['a', 'b', 'c', 'd']);
    expect(weights(r).reduce((s, x) => s + x, 0)).toBeCloseTo(1, 6);
  });
});

describe('queries', () => {
  const t = split('row', [leaf('a'), split('col', [leaf('b'), leaf('c')]), leaf('d')], [1, 2, 1]);
  test('leafIds in document order', () => expect(leafIds(t)).toEqual(['a', 'b', 'c', 'd']));
});

describe('computeRects geometry', () => {
  const RECT = { x: 0, y: 0, width: 100, height: 100 };

  test('single leaf fills the container', () => {
    expect(computeRects(leaf('a'), RECT)).toEqual([{ id: 'a', x: 0, y: 0, width: 100, height: 100 }]);
  });

  test('row split divides width by weight', () => {
    const t = split('row', [leaf('a'), leaf('b')], [0.25, 0.75]);
    const rects = computeRects(t, RECT);
    expect(rects).toEqual([
      { id: 'a', x: 0, y: 0, width: 25, height: 100 },
      { id: 'b', x: 25, y: 0, width: 75, height: 100 },
    ]);
  });

  test('col split divides height', () => {
    const t = split('col', [leaf('a'), leaf('b')], [0.4, 0.6]);
    const rects = computeRects(t, RECT);
    expect(rects[0]).toEqual({ id: 'a', x: 0, y: 0, width: 100, height: 40 });
    expect(rects[1]).toEqual({ id: 'b', x: 0, y: 40, width: 100, height: 60 });
  });

  test('gutter is subtracted between siblings', () => {
    const t = split('row', [leaf('a'), leaf('b')], [0.5, 0.5]);
    const rects = computeRects(t, RECT, 10); // usable 90 → 45 each, b.x = 55
    expect(rects[0]).toEqual({ id: 'a', x: 0, y: 0, width: 45, height: 100 });
    expect(rects[1]).toEqual({ id: 'b', x: 55, y: 0, width: 45, height: 100 });
  });

  test('nested geometry: col under a row', () => {
    const t = split('row', [split('col', [leaf('a'), leaf('b')]), leaf('c')], [0.5, 0.5]);
    const rects = computeRects(t, RECT);
    expect(rects.find((r) => r.id === 'a')).toEqual({ id: 'a', x: 0, y: 0, width: 50, height: 50 });
    expect(rects.find((r) => r.id === 'b')).toEqual({ id: 'b', x: 0, y: 50, width: 50, height: 50 });
    expect(rects.find((r) => r.id === 'c')).toEqual({ id: 'c', x: 50, y: 0, width: 50, height: 100 });
  });

  test('rect total area is conserved (no gutter)', () => {
    const t = split('row', [leaf('a'), split('col', [leaf('b'), leaf('c')]), leaf('d')], [0.2, 0.5, 0.3]);
    const area = computeRects(t, RECT).reduce((s, r) => s + r.width * r.height, 0);
    expect(area).toBeCloseTo(100 * 100, 4);
  });
});
