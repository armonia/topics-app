/**
 * Standalone column-stack math: where the new slots land, whose height pays
 * for them, and the depth cap.
 *
 * @covers LAYOUT-01
 */
import { describe, it, expect } from 'bun:test';
import type { PanelGridRow } from '../../types';
import { addKeysToCellStack, applyVerticalDrop, cellStackDepth, flattenCellColumn } from './panelGridStacks';
import { MAX_ROWS, MAX_STACK_DEPTH } from './constants';

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const row = (itemKeys: string[], cellStacks?: PanelGridRow['cellStacks']): PanelGridRow => ({
  itemKeys,
  widths: itemKeys.map(() => 1 / itemKeys.length),
  ...(cellStacks ? { cellStacks } : {}),
});

describe('cellStackDepth / flattenCellColumn', () => {
  it('counts the primary plus its items', () => {
    const r = row(['A', 'B'], { A: { items: ['A2'], heights: [0.5, 0.5] } });
    expect(cellStackDepth(r, 'A')).toBe(2);
    expect(cellStackDepth(r, 'B')).toBe(1);
    expect(flattenCellColumn(r, 'A')).toEqual(['A', 'A2']);
    expect(flattenCellColumn(r, 'B')).toEqual(['B']);
  });
});

describe('addKeysToCellStack — bottom', () => {
  it('starts a stack under a plain cell, 50/50, siblings untouched', () => {
    const next = addKeysToCellStack(row(['A', 'B']), 'A', ['NEW'], 'bottom')!;
    expect(next.itemKeys).toEqual(['A', 'B']);
    expect(next.widths).toEqual([0.5, 0.5]);
    expect(next.cellStacks?.A.items).toEqual(['NEW']);
    expect(next.cellStacks?.A.heights).toEqual([0.5, 0.5]);
  });
  it('appends at the column foot and halves only the foot slot', () => {
    const r = row(['A'], { A: { items: ['A2'], heights: [0.8, 0.2] } });
    const next = addKeysToCellStack(r, 'A', ['NEW'], 'bottom')!;
    expect(next.cellStacks?.A.items).toEqual(['A2', 'NEW']);
    // A keeps its manual 0.8; only A2's 0.2 is split.
    expect(next.cellStacks?.A.heights).toEqual([0.8, 0.1, 0.1]);
  });
  it('lands a whole moved column, its members included', () => {
    const r = row(['A', 'B'], { A: { items: ['A2'], heights: [0.5, 0.5] } });
    const next = addKeysToCellStack(r, 'A', ['C', 'C2'], 'bottom')!;
    expect(next.cellStacks?.A.items).toEqual(['A2', 'C', 'C2']);
    expect(sum(next.cellStacks!.A.heights)).toBeCloseTo(1, 6);
    // The foot slot (0.5) is cut three ways, the head keeps its 0.5.
    expect(next.cellStacks?.A.heights[0]).toBeCloseTo(0.5, 6);
  });
  it('keeps sibling columns sub-stacks', () => {
    const r = row(['A', 'B'], { B: { items: ['B2'], heights: [0.5, 0.5] } });
    const next = addKeysToCellStack(r, 'A', ['NEW'], 'bottom')!;
    expect(next.cellStacks?.B.items).toEqual(['B2']);
  });
});

describe('addKeysToCellStack — top', () => {
  it('promotes the new key to primary and demotes the old one', () => {
    const next = addKeysToCellStack(row(['A', 'B']), 'A', ['NEW'], 'top')!;
    expect(next.itemKeys).toEqual(['NEW', 'B']);
    expect(next.cellStacks?.NEW.items).toEqual(['A']);
    expect(next.cellStacks?.A).toBeUndefined();
    expect(next.cellStacks?.NEW.heights).toEqual([0.5, 0.5]);
  });
  it('halves only the head slot of an existing stack', () => {
    const r = row(['A'], { A: { items: ['A2'], heights: [0.8, 0.2] } });
    const next = addKeysToCellStack(r, 'A', ['NEW'], 'top')!;
    expect(next.itemKeys).toEqual(['NEW']);
    expect(next.cellStacks?.NEW.items).toEqual(['A', 'A2']);
    expect(next.cellStacks?.NEW.heights).toEqual([0.4, 0.4, 0.2]);
  });
});

describe('addKeysToCellStack — refusals', () => {
  it('returns null for a key that is not a top-level cell', () => {
    const r = row(['A'], { A: { items: ['A2'], heights: [0.5, 0.5] } });
    expect(addKeysToCellStack(r, 'A2', ['NEW'], 'bottom')).toBeNull();
    expect(addKeysToCellStack(r, 'Z', ['NEW'], 'bottom')).toBeNull();
  });
  it('returns null past MAX_STACK_DEPTH', () => {
    const items = Array.from({ length: MAX_STACK_DEPTH - 1 }, (_, i) => `A${i + 2}`);
    const heights = Array.from({ length: MAX_STACK_DEPTH }, () => 1 / MAX_STACK_DEPTH);
    const r = row(['A'], { A: { items, heights } });
    expect(addKeysToCellStack(r, 'A', ['OVERFLOW'], 'bottom')).toBeNull();
  });
  it('refuses a multi-key move that would overflow, rather than truncating', () => {
    const items = Array.from({ length: MAX_STACK_DEPTH - 2 }, (_, i) => `A${i + 2}`);
    const heights = Array.from({ length: MAX_STACK_DEPTH - 1 }, () => 1 / (MAX_STACK_DEPTH - 1));
    const r = row(['A'], { A: { items, heights } });
    expect(addKeysToCellStack(r, 'A', ['C'], 'bottom')).not.toBeNull();
    expect(addKeysToCellStack(r, 'A', ['C', 'C2'], 'bottom')).toBeNull();
  });
  it('does not mutate the input row', () => {
    const r = row(['A'], { A: { items: ['A2'], heights: [0.8, 0.2] } });
    const snapshot = JSON.stringify(r);
    addKeysToCellStack(r, 'A', ['NEW'], 'top');
    expect(JSON.stringify(r)).toBe(snapshot);
  });
  it('falls back to an even column when stored heights are corrupt', () => {
    const r = row(['A'], { A: { items: ['A2'], heights: [1] } });
    const next = addKeysToCellStack(r, 'A', ['NEW'], 'bottom')!;
    expect(next.cellStacks?.A.heights.length).toBe(3);
    expect(sum(next.cellStacks!.A.heights)).toBeCloseTo(1, 6);
  });
});

describe('applyVerticalDrop — the same gesture gives the same layout', () => {
  // Grid [A, C]; the tab is dropped on C's bottom edge, no strip involved.
  const grid = () => [row(['A', 'C'])];

  it('a bare bottom edge stacks in the column, whatever the source was', () => {
    // Source in the pool: nothing to remove from the grid, one new key.
    const fromPool = applyVerticalDrop({
      rows: grid(), targetRowIdx: 0, targetKey: 'C',
      moved: { key: 'B' }, edge: 'bottom', fullRowIntent: false,
    })!;
    // Source already a cell of its own: its slot is gone from the row by the
    // time we get here, so the grid it lands in has one column less.
    const fromCell = applyVerticalDrop({
      rows: [row(['C'])], targetRowIdx: 0, targetKey: 'C',
      moved: { key: 'B' }, edge: 'bottom', fullRowIntent: false,
    })!;
    expect(fromPool[0].cellStacks?.C.items).toEqual(['B']);
    expect(fromPool.length).toBe(1);
    // The shape of the target's column is identical in both: a stack, never a row.
    expect(fromCell[0].cellStacks?.C).toEqual(fromPool[0].cellStacks!.C);
    expect(fromCell.length).toBe(1);
  });

  it('a bare top edge makes the dropped cell the column primary', () => {
    const next = applyVerticalDrop({
      rows: grid(), targetRowIdx: 0, targetKey: 'C',
      moved: { key: 'B' }, edge: 'top', fullRowIntent: false,
    })!;
    expect(next[0].itemKeys).toEqual(['A', 'B']);
    expect(next[0].cellStacks?.B.items).toEqual(['C']);
  });

  it('only a strip intent inserts a full-width row', () => {
    const next = applyVerticalDrop({
      rows: grid(), targetRowIdx: 0, targetKey: 'C',
      moved: { key: 'B' }, edge: 'bottom', fullRowIntent: true,
    })!;
    expect(next.length).toBe(2);
    expect(next[1]).toEqual({ itemKeys: ['B'], widths: [1] });
    expect(next[0].cellStacks).toBeUndefined();
  });

  it('a full-width row keeps the moved cell sub-stack verbatim', () => {
    const next = applyVerticalDrop({
      rows: grid(), targetRowIdx: 0, targetKey: 'C',
      moved: { key: 'B', stack: { items: ['B2'], heights: [0.7, 0.3] } },
      edge: 'top', fullRowIntent: true,
    })!;
    expect(next[0].cellStacks?.B.heights).toEqual([0.7, 0.3]);
    expect(next[1]).toEqual(grid()[0]);
  });

  it('a moved cell carrying a sub-stack lands whole in the column', () => {
    const next = applyVerticalDrop({
      rows: grid(), targetRowIdx: 0, targetKey: 'C',
      moved: { key: 'B', stack: { items: ['B2'], heights: [0.7, 0.3] } },
      edge: 'bottom', fullRowIntent: false,
    })!;
    expect(next[0].cellStacks?.C.items).toEqual(['B', 'B2']);
    expect(next.length).toBe(1);
  });

  it('refuses a full-width row past MAX_ROWS instead of silently stacking', () => {
    const rows = Array.from({ length: MAX_ROWS }, () => row(['C']));
    const next = applyVerticalDrop({
      rows, targetRowIdx: 0, targetKey: 'C',
      moved: { key: 'B' }, edge: 'bottom', fullRowIntent: true,
    });
    expect(next).toBeNull();
  });

  it('refuses a target that is not a top-level cell', () => {
    const rows = [row(['A'], { A: { items: ['A2'], heights: [0.5, 0.5] } })];
    expect(applyVerticalDrop({
      rows, targetRowIdx: 0, targetKey: 'A2',
      moved: { key: 'B' }, edge: 'bottom', fullRowIntent: false,
    })).toBeNull();
    expect(applyVerticalDrop({
      rows, targetRowIdx: 9, targetKey: 'A',
      moved: { key: 'B' }, edge: 'bottom', fullRowIntent: false,
    })).toBeNull();
  });
});
