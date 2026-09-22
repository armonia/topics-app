/**
 * Standalone column-stack math: where the new slots land, whose height pays
 * for them, and the depth cap.
 *
 * @covers LAYOUT-01
 */
import { describe, it, expect } from 'bun:test';
import type { PanelGridRow } from '../../types';
import { addKeysToCellStack, cellStackDepth, flattenCellColumn } from './panelGridStacks';
import { MAX_STACK_DEPTH } from './constants';

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
