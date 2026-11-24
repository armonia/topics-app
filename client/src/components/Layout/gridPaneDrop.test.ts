/**
 * @covers SPLIT-01
 */
import { describe, expect, test } from 'bun:test';
import type { PanelGridRow } from '../../types';
import { MAX_COLS_PER_ROW } from './constants';
import { moveCell, newCellOverCap, placeNewCell } from './gridPaneDrop';

const one = (): PanelGridRow[] => [{ itemKeys: ['standalone'], widths: [1] }];

describe('placeNewCell: a pane gets its own cell beside the target', () => {
  test('right edge: the new cell sits on the right and halves the target', () => {
    const rows = placeNewCell(one(), 'solo:b', null, { targetKey: 'standalone', zone: 'right' });
    expect(rows[0].itemKeys).toEqual(['standalone', 'solo:b']);
    expect(rows[0].widths[0]).toBeCloseTo(0.5);
    expect(rows[0].widths[1]).toBeCloseTo(0.5);
  });

  test('left edge: the new cell sits on the left', () => {
    expect(placeNewCell(one(), 'solo:b', null, { targetKey: 'standalone', zone: 'left' })[0].itemKeys)
      .toEqual(['solo:b', 'standalone']);
  });

  test('bottom edge of a cell: it stacks under that column, the row stays one', () => {
    const rows = placeNewCell(
      [{ itemKeys: ['standalone', 'solo:c'], widths: [0.5, 0.5] }],
      'solo:b', null, { targetKey: 'solo:c', zone: 'bottom' },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].cellStacks?.['solo:c']?.items).toEqual(['solo:b']);
  });

  test('top edge of a cell: the new pane heads the column, the old one stacks under it', () => {
    const rows = placeNewCell(
      [{ itemKeys: ['standalone', 'solo:c'], widths: [0.5, 0.5] }],
      'solo:b', null, { targetKey: 'solo:c', zone: 'top' },
    );
    expect(rows[0].itemKeys).toEqual(['standalone', 'solo:b']);
    expect(rows[0].cellStacks?.['solo:b']?.items).toEqual(['solo:c']);
  });

  test('a strip above the grid: a full-width row on top', () => {
    const rows = placeNewCell(one(), 'solo:b', null, { targetKey: 'standalone', zone: 'top', fullRow: true });
    expect(rows.map((r) => r.itemKeys)).toEqual([['solo:b'], ['standalone']]);
  });

  test('a target that vanished since the drag began changes nothing', () => {
    const prev = one();
    expect(placeNewCell(prev, 'solo:b', null, { targetKey: 'solo:gone', zone: 'right' })).toBe(prev);
  });

  test('at the column cap the side edges are refused, and nothing moves', () => {
    const keys = Array.from({ length: MAX_COLS_PER_ROW }, (_, i) => (i === 0 ? 'a' : `c${i}`));
    const full: PanelGridRow[] = [{ itemKeys: keys, widths: keys.map(() => 1 / keys.length) }];
    expect(newCellOverCap(full, { targetKey: 'a', zone: 'right' })).toBe(true);
    expect(newCellOverCap(full, { targetKey: 'a', zone: 'bottom' })).toBe(false);
    expect(placeNewCell(full, 'solo:e', null, { targetKey: 'a', zone: 'right' })).toBe(full);
  });

  test('the primary of a multi-tab cell leaves it: the cell stays in place under its next member', () => {
    const rows = placeNewCell(
      [{ itemKeys: ['solo:a', 'solo:z'], widths: [0.5, 0.5] }],
      'solo:a', 'solo:b', { targetKey: 'solo:z', zone: 'right' },
    );
    expect(rows[0].itemKeys).toEqual(['solo:b', 'solo:z', 'solo:a']);
  });
});

describe('moveCell: a whole cell moves beside the target', () => {
  test('to the right of the last cell', () => {
    const rows = moveCell([{ itemKeys: ['a', 'b', 'c'], widths: [1 / 3, 1 / 3, 1 / 3] }], 'a', { targetKey: 'c', zone: 'right' });
    expect(rows[0].itemKeys).toEqual(['b', 'c', 'a']);
  });

  test('a cell whose target vanished goes to the end of the last row', () => {
    const rows = moveCell(
      [{ itemKeys: ['a', 'b'], widths: [0.5, 0.5] }, { itemKeys: ['c'], widths: [1] }],
      'a', { targetKey: 'gone', zone: 'left' },
    );
    expect(rows.map((r) => r.itemKeys)).toEqual([['b'], ['c', 'a']]);
  });

  test('onto itself nothing changes', () => {
    const prev: PanelGridRow[] = [{ itemKeys: ['a', 'b'], widths: [0.5, 0.5] }];
    expect(moveCell(prev, 'a', { targetKey: 'a', zone: 'right' })).toBe(prev);
  });
});
