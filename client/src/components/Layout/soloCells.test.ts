/**
 * The solo-cell model behind merging topic tabs into one grid cell: moving,
 * extracting, pruning, re-keying and reordering, with the primary pinned.
 *
 * @covers LAYOUT-01
 */
import { describe, test, expect } from 'bun:test';
import {
  soloCellKey, flattenSoloCells, removeTopicFromCells, extractToOwnCell,
  moveTopicToCell, pruneSoloCells, soloCellsFromFlat, primaryFromSoloCellKey,
  remapTopicInCells, reorderCellPreservingPrimary,
} from './soloCells';

describe('soloCells — model primitives', () => {
  test('single-topic cells migrate 1:1 from flat (no grid re-keying)', () => {
    expect(soloCellsFromFlat(['A', 'B'])).toEqual([['A'], ['B']]);
    expect(soloCellKey(['A'])).toBe('solo:A');
    expect(soloCellKey(['B', 'A'])).toBe('solo:B'); // primary = first
  });

  test('THE FEATURE: moveTopicToCell merges a tab into a populated cell', () => {
    // drop A onto cell B → B's cell becomes [B, A]; A's old cell collapses
    expect(moveTopicToCell([['A'], ['B']], 'A', 'B')).toEqual([['B', 'A']]);
    // from the pool (A not solo) onto cell B → A joins B
    expect(moveTopicToCell([['B']], 'A', 'B')).toEqual([['B', 'A']]);
    // into an already-multi cell, appended last
    expect(moveTopicToCell([['B', 'C'], ['A']], 'A', 'B')).toEqual([['B', 'C', 'A']]);
  });

  test('moveTopicToCell never leaves a topic in two cells', () => {
    const out = moveTopicToCell([['A'], ['B', 'A']], 'A', 'B'); // A spuriously in two
    expect(flattenSoloCells(out).filter((x) => x === 'A')).toHaveLength(1);
  });

  test('moving the last tab out of a column collapses that column, others intact', () => {
    expect(moveTopicToCell([['A'], ['B'], ['C']], 'A', 'C')).toEqual([['B'], ['C', 'A']]);
  });

  test('self-merge is a no-op', () => {
    expect(moveTopicToCell([['A']], 'A', 'A')).toEqual([['A']]);
  });

  test('extractToOwnCell pulls a member tab out of a multi-tab cell into its own', () => {
    expect(extractToOwnCell([['B', 'A']], 'A')).toEqual([['B'], ['A']]);
    // a pool topic (not solo yet) just becomes its own cell
    expect(extractToOwnCell([['B']], 'W')).toEqual([['B'], ['W']]);
  });

  test('removeTopicFromCells drops the topic and any emptied cell', () => {
    expect(removeTopicFromCells([['B', 'A']], 'A')).toEqual([['B']]);
    expect(removeTopicFromCells([['A']], 'A')).toEqual([]); // emptied → gone
    const same = [['A'], ['B']];
    expect(removeTopicFromCells(same, 'Z')).toBe(same); // unchanged ref
  });

  test('pruneSoloCells drops closed topics + empty cells, keeps ref when stable', () => {
    expect(pruneSoloCells([['B', 'A'], ['C']], new Set(['B', 'C']))).toEqual([['B'], ['C']]);
    const stable = [['A'], ['B']];
    expect(pruneSoloCells(stable, new Set(['A', 'B']))).toBe(stable);
  });
});

describe('soloCells — draft promotion remap (topics:pane-id-remap)', () => {
  test('renames a member in place, preserving order', () => {
    expect(remapTopicInCells([['A', 'draft:1', 'C']], 'draft:1', 'T')).toEqual([['A', 'T', 'C']]);
  });

  test('renames a PRIMARY in place (the cell re-keys, membership survives)', () => {
    expect(remapTopicInCells([['draft:1', 'B']], 'draft:1', 'T')).toEqual([['T', 'B']]);
  });

  test('returns the same ref when the id is in no cell', () => {
    const cells = [['A'], ['B']];
    expect(remapTopicInCells(cells, 'draft:9', 'T')).toBe(cells);
    expect(remapTopicInCells(cells, 'A', 'A')).toBe(cells); // from === to
  });
});

describe('soloCells — cell reorder persistence (primary pinned)', () => {
  test('members take the new order, primary stays at slot 0', () => {
    expect(reorderCellPreservingPrimary(['A', 'B', 'C'], ['A', 'C', 'B'])).toEqual(['A', 'C', 'B']);
    // A reorder that visually puts a member before the primary still persists
    // the members' relative order — the primary is the cell's grid key.
    expect(reorderCellPreservingPrimary(['A', 'B', 'C'], ['C', 'A', 'B'])).toEqual(['A', 'C', 'B']);
  });

  test('members missing from the new order are kept (appended, old order)', () => {
    expect(reorderCellPreservingPrimary(['A', 'B', 'C', 'D'], ['A', 'D'])).toEqual(['A', 'D', 'B', 'C']);
  });

  test('foreign ids in the new order are ignored', () => {
    expect(reorderCellPreservingPrimary(['A', 'B'], ['A', 'Z', 'B'])).toEqual(['A', 'B']);
  });

  test('returns the same ref when nothing changes', () => {
    const cell = ['A', 'B'];
    expect(reorderCellPreservingPrimary(cell, ['A', 'B'])).toBe(cell);
    const single = ['A'];
    expect(reorderCellPreservingPrimary(single, ['A'])).toBe(single);
  });
});

describe('soloCells — "+" add-tab routing (the cell that owns the clicked tab bar)', () => {
  test('primaryFromSoloCellKey is the inverse of soloCellKey', () => {
    expect(primaryFromSoloCellKey('solo:A')).toBe('A');
    expect(primaryFromSoloCellKey(soloCellKey(['B', 'A']))).toBe('B');
  });

  test('the main pool is never a merge target', () => {
    expect(primaryFromSoloCellKey('standalone')).toBe(null);
    expect(primaryFromSoloCellKey('solo:')).toBe(null); // malformed key
  });

  test('THE BUG: a pane created from a split cell\'s "+" lands in THAT cell, not the pool', () => {
    // Layout: main pool + split cell [A]. The user clicks "+" → Shell on
    // cell A's tab bar (gridItemKey 'solo:A'); the new terminal pane must
    // become A's next tab — NOT a regular pool pane in the other tab bar.
    const target = primaryFromSoloCellKey('solo:A');
    expect(target).toBe('A');
    const cells = moveTopicToCell([['A']], 'terminal:t1', target!);
    expect(cells).toEqual([['A', 'terminal:t1']]);
    // Solo membership is what keeps it OUT of the standalone pool's panes.
    expect(flattenSoloCells(cells)).toContain('terminal:t1');
  });
});
