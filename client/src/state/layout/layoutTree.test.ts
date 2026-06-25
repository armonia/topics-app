import { test, expect, describe } from 'bun:test';
import {
  leaf,
  split,
  normalize,
  isSplit,
  isLeaf,
  leafIds,
  leafCount,
  hasLeaf,
  pathToLeaf,
  nodeAt,
  splitLeaf,
  closeLeaf,
  moveLeaf,
  resizeAt,
  setWeightAt,
  equalizeAt,
  equalizeAll,
  computeRects,
  treesEqual,
  MIN_CHILD_WEIGHT,
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
});

describe('queries', () => {
  const t = split('row', [leaf('a'), split('col', [leaf('b'), leaf('c')]), leaf('d')], [1, 2, 1]);
  test('leafIds in document order', () => expect(leafIds(t)).toEqual(['a', 'b', 'c', 'd']));
  test('leafCount', () => expect(leafCount(t)).toBe(4));
  test('hasLeaf', () => {
    expect(hasLeaf(t, 'c')).toBe(true);
    expect(hasLeaf(t, 'z')).toBe(false);
  });
  test('pathToLeaf', () => {
    expect(pathToLeaf(t, 'a')).toEqual([0]);
    expect(pathToLeaf(t, 'c')).toEqual([1, 1]);
    expect(pathToLeaf(t, 'z')).toBeNull();
  });
  test('nodeAt resolves the addressed node', () => {
    expect(nodeAt(t, [1, 0])).toEqual(leaf('b'));
    expect(nodeAt(t, [9])).toBeNull();
  });
});

describe('splitLeaf (donor halves, siblings preserved)', () => {
  test('splitting a column halves only the donor', () => {
    const t = split('row', [leaf('a'), leaf('b'), leaf('c')], [0.2, 0.3, 0.5]);
    const r = splitLeaf(t, 'b', 'right', 'd');
    expect(leafIds(r)).toEqual(['a', 'b', 'd', 'c']);
    const w = weights(r);
    expect(w[0]).toBeCloseTo(0.2, 6); // a untouched
    expect(w[1]).toBeCloseTo(0.15, 6); // b halved
    expect(w[2]).toBeCloseTo(0.15, 6); // d = other half
    expect(w[3]).toBeCloseTo(0.5, 6); // c untouched
    expect(w.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 6);
  });

  test('left edge inserts before the donor', () => {
    const t = split('row', [leaf('a'), leaf('b')]);
    const r = splitLeaf(t, 'b', 'left', 'x');
    expect(leafIds(r)).toEqual(['a', 'x', 'b']);
  });

  test('cross-axis split nests (leaf → col under a row)', () => {
    const t = split('row', [leaf('a'), leaf('b')]);
    const r = splitLeaf(t, 'a', 'bottom', 'c'); // a splits vertically
    expect(asSplit(r).dir).toBe('row');
    expect(leafIds(r)).toEqual(['a', 'c', 'b']);
    expect(asSplit(asSplit(r).children[0].node).dir).toBe('col');
  });

  test('custom ratio respected (before)', () => {
    const r = splitLeaf(leaf('a'), 'a', 'left', 'b', 0.25);
    expect(leafIds(r)).toEqual(['b', 'a']);
    expect(weights(r)[0]).toBeCloseTo(0.25, 6);
    expect(weights(r)[1]).toBeCloseTo(0.75, 6);
  });

  test('missing target → unchanged', () => {
    const t = split('row', [leaf('a'), leaf('b')]);
    expect(treesEqual(splitLeaf(t, 'zzz', 'right', 'x'), t)).toBe(true);
  });
});

describe('closeLeaf', () => {
  test('survivors keep relative proportions, renormalised', () => {
    const t = split('row', [leaf('a'), leaf('b'), leaf('c')], [0.2, 0.3, 0.5]);
    const r = closeLeaf(t, 'b')!;
    expect(leafIds(r)).toEqual(['a', 'c']);
    const w = weights(r);
    expect(w[0]).toBeCloseTo(0.2 / 0.7, 6);
    expect(w[1]).toBeCloseTo(0.5 / 0.7, 6);
  });

  test('closing down to one leaf collapses the split away', () => {
    const t = split('row', [leaf('a'), leaf('b')]);
    const r = closeLeaf(t, 'a')!;
    expect(isLeaf(r)).toBe(true);
    expect((r as { id: string }).id).toBe('b');
  });

  test('closing the last leaf yields null', () => {
    expect(closeLeaf(leaf('only'), 'only')).toBeNull();
  });

  test('nested: collapsing an inner split bubbles up', () => {
    const t = split('row', [leaf('a'), split('col', [leaf('b'), leaf('c')])], [0.5, 0.5]);
    const r = closeLeaf(t, 'c')!; // inner col loses c → collapses to b
    expect(leafIds(r)).toEqual(['a', 'b']);
    expect(asSplit(r).children.every((ch) => isLeaf(ch.node))).toBe(true);
  });
});

describe('moveLeaf', () => {
  test('relocate a column to the far left', () => {
    const t = split('row', [leaf('a'), leaf('b'), leaf('c')]);
    const r = moveLeaf(t, 'c', 'a', 'left');
    expect(leafIds(r)).toEqual(['c', 'a', 'b']);
  });

  test('move to a new axis (split target vertically)', () => {
    const t = split('row', [leaf('a'), leaf('b')]);
    const r = moveLeaf(t, 'b', 'a', 'bottom');
    expect(leafIds(r)).toEqual(['a', 'b']);
    // a now hosts a col-split [a, b]; the outer row collapsed to that single col.
    expect(asSplit(r).dir).toBe('col');
  });

  test('source == target → no-op', () => {
    const t = split('row', [leaf('a'), leaf('b')]);
    expect(treesEqual(moveLeaf(t, 'a', 'a', 'right'), t)).toBe(true);
  });
});

describe('resize', () => {
  test('shift weight between adjacent children, others untouched', () => {
    const t = split('row', [leaf('a'), leaf('b'), leaf('c')]); // ~1/3 each
    const r = resizeAt(t, [], 0, 0.1);
    const w = weights(r);
    expect(w[0]).toBeCloseTo(1 / 3 + 0.1, 6);
    expect(w[1]).toBeCloseTo(1 / 3 - 0.1, 6);
    expect(w[2]).toBeCloseTo(1 / 3, 6);
  });

  test('clamps to MIN_CHILD_WEIGHT', () => {
    const t = split('row', [leaf('a'), leaf('b')]);
    const r = resizeAt(t, [], 0, -5);
    expect(weights(r)[0]).toBeCloseTo(MIN_CHILD_WEIGHT, 6);
    expect(weights(r)[1]).toBeCloseTo(1 - MIN_CHILD_WEIGHT, 6);
  });

  test('invalid divider index → unchanged', () => {
    const t = split('row', [leaf('a'), leaf('b')]);
    expect(treesEqual(resizeAt(t, [], 5, 0.1), t)).toBe(true);
  });

  test('setWeightAt rebalances the band', () => {
    const t = split('row', [leaf('a'), leaf('b'), leaf('c')]);
    const r = setWeightAt(t, [], 1, 0.6);
    expect(weights(r)[1]).toBeGreaterThan(weights(r)[0]);
    expect(weights(r).reduce((s, x) => s + x, 0)).toBeCloseTo(1, 6);
  });
});

describe('equalize', () => {
  test('equalizeAt evens the addressed band', () => {
    const t = split('row', [leaf('a'), leaf('b'), leaf('c')], [0.1, 0.1, 0.8]);
    const r = equalizeAt(t, []);
    expect(weights(r)).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });

  test('equalizeAll evens every split recursively', () => {
    const t = split('row', [leaf('a'), split('col', [leaf('b'), leaf('c'), leaf('d')], [0.6, 0.3, 0.1])], [0.8, 0.2]);
    const r = equalizeAll(t);
    expect(weights(r)).toEqual([0.5, 0.5]);
    expect(weights(asSplit(r).children[1].node)).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });
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

describe('round-trip invariants', () => {
  test('split then close the inserted pane restores the leaf set (faithful redistribution)', () => {
    const t = split('row', [leaf('a'), leaf('b')], [0.3, 0.7]);
    const grown = splitLeaf(t, 'a', 'right', 'x'); // a 0.3 → a 0.15, x 0.15, b 0.7
    const shrunk = closeLeaf(grown, 'x')!;
    expect(leafIds(shrunk)).toEqual(['a', 'b']);
    // Closing x redistributes its space PROPORTIONALLY across survivors (the
    // current gridWidths `keepColumnWidths` semantics), so the donor keeps only
    // its post-split weight — a:b is now 0.15:0.7, NOT the original 0.3:0.7.
    const w = weights(shrunk);
    expect(w[0] / w[1]).toBeCloseTo(0.15 / 0.7, 5);
    expect(w[0] + w[1]).toBeCloseTo(1, 6);
  });
});
