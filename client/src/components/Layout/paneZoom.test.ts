/**
 * The mechanism of the zoom: weights go to zero, the tree keeps its shape.
 *
 * Every assertion here is about the two things that make "entering and leaving
 * the zoom remounts nothing" true — leaf ids untouched, and a tree handed back
 * BY REFERENCE when the answer is a no-op — plus the pane→cell walk the whole
 * feature stands on and the pruning that closes it when a cell dies.
 *
 * The trees are built with the production builder (`buildShallowGridTree`), not
 * with hand-written nodes: a fixture that drifted from the real shape would
 * prove the zoom against a tree nobody renders.
 *
 * @covers LAYOUT-35, LAYOUT-36, LAYOUT-37
 */
import { describe, test, expect } from 'bun:test';
import { buildShallowGridTree } from '../../state/layout/legacyAdapters';
import { isLeaf, isSplit, type LayoutNode } from '../../state/layout/layoutTree';
import {
  applyZoomWeights,
  cellKeysForPanes,
  liveCellKeys,
  pruneZoom,
  type ZoomGridItem,
  type ZoomRow,
} from './paneZoom';

/** Two rows: [standalone | solo:B] over [solo:C]. */
function grid(): LayoutNode {
  const root = buildShallowGridTree(
    [
      { keys: ['standalone', 'solo:B'], widths: [0.6, 0.4] },
      { keys: ['solo:C'], widths: [1] },
    ],
    [0.7, 0.3],
    () => true,
  );
  if (!root) throw new Error('fixture: empty tree');
  return root;
}

/** Row weights, top to bottom. */
function rowWeights(root: LayoutNode): number[] {
  if (!isSplit(root)) throw new Error('expected a split at the root');
  return root.children.map((c) => c.weight);
}

/** Leaf id → its weight, for one row. */
function rowLeafWeights(root: LayoutNode, rowIndex: number): Record<string, number> {
  if (!isSplit(root)) throw new Error('expected a split at the root');
  const row = root.children[rowIndex]?.node;
  if (!row || !isSplit(row)) throw new Error(`expected a split at row ${rowIndex}`);
  const out: Record<string, number> = {};
  for (const col of row.children) {
    if (!isLeaf(col.node)) throw new Error('expected leaves as columns');
    out[col.node.id] = col.weight;
  }
  return out;
}

/** The subtree of one row, to compare by reference. */
function rowNode(root: LayoutNode, rowIndex: number): LayoutNode {
  if (!isSplit(root)) throw new Error('expected a split at the root');
  const row = root.children[rowIndex]?.node;
  if (!row) throw new Error(`expected a row at ${rowIndex}`);
  return row;
}

describe('applyZoomWeights', () => {
  test('only the cells OUTSIDE the set lose their weight, and the ids stay', () => {
    const root = grid();
    const zoomed = applyZoomWeights(root, new Set(['standalone']));
    expect(rowWeights(zoomed!)).toEqual([0.7, 0]);
    expect(rowLeafWeights(zoomed!, 0)).toEqual({ standalone: 0.6, 'solo:B': 0 });
    // The ids are the React keys: a zoom that renamed one would remount the
    // pane it was meant to reveal.
    expect(Object.keys(rowLeafWeights(zoomed!, 0))).toEqual(Object.keys(rowLeafWeights(root, 0)));
    expect(Object.keys(rowLeafWeights(zoomed!, 1))).toEqual(['solo:C']);
  });

  test('a whole ROW collapses when none of its columns is in the set', () => {
    const root = grid();
    const zoomed = applyZoomWeights(root, new Set(['solo:C']));
    expect(rowWeights(zoomed!)).toEqual([0, 0.3]);
    // The collapsed row is handed back by REFERENCE, weights inside untouched:
    // at weight 0 it occupies nothing, and rewriting its children would throw
    // away the structural sharing that keeps the memo downstream cheap.
    expect(rowNode(zoomed!, 0)).toBe(rowNode(root, 0));
    expect(rowLeafWeights(zoomed!, 1)).toEqual({ 'solo:C': 1 });
  });

  test('a set that spans two cells keeps both, and only them', () => {
    const zoomed = applyZoomWeights(grid(), new Set(['standalone', 'solo:C']));
    expect(rowWeights(zoomed!)).toEqual([0.7, 0.3]);
    expect(rowLeafWeights(zoomed!, 0)).toEqual({ standalone: 0.6, 'solo:B': 0 });
    expect(rowLeafWeights(zoomed!, 1)).toEqual({ 'solo:C': 1 });
  });

  test('an empty set hands back the SAME tree, by reference', () => {
    const root = grid();
    expect(applyZoomWeights(root, new Set())).toBe(root);
  });

  test('a set covering every cell is a no-op, by reference', () => {
    const root = grid();
    expect(applyZoomWeights(root, new Set(['standalone', 'solo:B', 'solo:C']))).toBe(root);
  });

  test('a set that matches no cell leaves the grid alone instead of blanking it', () => {
    // The set is pruned in an effect, one render behind: a key that dies between
    // two renders really does arrive here, and zeroing everything would paint an
    // empty window for that frame.
    const root = grid();
    expect(applyZoomWeights(root, new Set(['solo:GONE']))).toBe(root);
  });

  test('a null tree stays null', () => {
    expect(applyZoomWeights(null, new Set(['standalone']))).toBeNull();
  });
});

/** [chat A | browser of A] over [terminal], with a second chat stacked under the
 *  first cell. */
function rows(): ZoomRow[] {
  return [
    { itemKeys: ['standalone', 'solo:B'], cellStacks: { standalone: { items: ['solo:S'] } } },
    { itemKeys: ['solo:C'] },
  ];
}

function items(entries: Array<[string, string[]]>): ReadonlyMap<string, ZoomGridItem> {
  return new Map(entries.map(([key, panelIds]) => [key, { key, panelIds }]));
}

const ITEM_MAP = items([
  ['standalone', ['topic-a']],
  ['solo:B', ['browser:topic-a']],
  ['solo:C', ['terminal:t1']],
  ['solo:S', ['topic-stacked']],
]);

describe('cellKeysForPanes', () => {
  test('a pane answers with the cell that hosts it', () => {
    expect([...cellKeysForPanes(rows(), ITEM_MAP, ['browser:topic-a'])]).toEqual(['solo:B']);
  });

  test('a STACKED pane answers with the cell that draws it, not with its own key', () => {
    // `solo:S` is a sub-stack member: it is not a tree leaf, so revealing it
    // means revealing the cell it lives inside.
    expect([...cellKeysForPanes(rows(), ITEM_MAP, ['topic-stacked'])]).toEqual(['standalone']);
  });

  test('several panes answer in ROW ORDER, so the first element is the first cell', () => {
    expect([...cellKeysForPanes(rows(), ITEM_MAP, ['terminal:t1', 'topic-a'])])
      .toEqual(['standalone', 'solo:C']);
  });

  test('a pane that is not on this surface answers with nothing', () => {
    expect(cellKeysForPanes(rows(), ITEM_MAP, ['browser:elsewhere']).size).toBe(0);
    expect(cellKeysForPanes(rows(), ITEM_MAP, []).size).toBe(0);
  });
});

describe('liveCellKeys', () => {
  test('a key the item map does not know is NOT a live cell', () => {
    // The builder turns it into an inert `__skip:` leaf at weight 0: nobody sees
    // it, so nobody can zoom away from it either.
    const withGhost: ZoomRow[] = [{ itemKeys: ['standalone', 'solo:GHOST'] }];
    expect([...liveCellKeys(withGhost, ITEM_MAP)]).toEqual(['standalone']);
  });

  test('a key repeated in another row counts once', () => {
    const repeated: ZoomRow[] = [{ itemKeys: ['standalone'] }, { itemKeys: ['standalone', 'solo:C'] }];
    expect([...liveCellKeys(repeated, ITEM_MAP)]).toEqual(['standalone', 'solo:C']);
  });
});

describe('pruneZoom', () => {
  test('a cell that died drops out of the set', () => {
    const kept = pruneZoom(new Set(['standalone', 'solo:B']), new Set(['standalone', 'solo:C']));
    expect([...kept]).toEqual(['standalone']);
  });

  test('nothing to drop hands back the SAME set, by reference', () => {
    const keys = new Set(['standalone', 'solo:B']);
    expect(pruneZoom(keys, new Set(['standalone', 'solo:B', 'solo:C']))).toBe(keys);
  });

  test('the anchor gone leaves an empty set, which is what closes the zoom', () => {
    expect(pruneZoom(new Set(['standalone']), new Set(['solo:C'])).size).toBe(0);
  });
});
