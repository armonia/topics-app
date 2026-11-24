/**
 * @covers SPLIT-04 @covers SPLIT-06
 */
import { describe, expect, test } from 'bun:test';
import { KEY_STEP, KEY_STEP_FINE, dividerKeyAction, neighborCell, type CellBox } from './splitKeyboard';

describe('a divider from the keyboard (SPLIT-04)', () => {
  test('the arrows along its axis move it, Shift makes the step fine', () => {
    expect(dividerKeyAction('ArrowRight', false, true)).toEqual({ kind: 'resize', fraction: KEY_STEP });
    expect(dividerKeyAction('ArrowLeft', true, true)).toEqual({ kind: 'resize', fraction: -KEY_STEP_FINE });
    expect(dividerKeyAction('ArrowDown', false, false)).toEqual({ kind: 'resize', fraction: KEY_STEP });
  });

  test('the arrows across its axis do nothing, Enter evens the band', () => {
    expect(dividerKeyAction('ArrowUp', false, true)).toBeNull();
    expect(dividerKeyAction('ArrowLeft', false, false)).toBeNull();
    expect(dividerKeyAction('Enter', false, true)).toEqual({ kind: 'equalize' });
  });
});

// Two columns; the right one is stacked: top-right over bottom-right.
const grid: CellBox[] = [
  { id: 'left', left: 0, top: 0, width: 500, height: 800 },
  { id: 'top-right', left: 500, top: 0, width: 500, height: 400 },
  { id: 'bottom-right', left: 500, top: 400, width: 500, height: 400 },
];

describe('the focus walks to the cell beside (SPLIT-06)', () => {
  test('right from the left column lands on the right column, up and down walk the stack', () => {
    expect(['top-right', 'bottom-right'].includes(neighborCell(grid, 'left', 'right') ?? '')).toBe(true);
    expect(neighborCell(grid, 'top-right', 'down')).toBe('bottom-right');
    expect(neighborCell(grid, 'bottom-right', 'up')).toBe('top-right');
    expect(neighborCell(grid, 'bottom-right', 'left')).toBe('left');
  });

  test('at the edge of the layout there is no neighbor', () => {
    expect(neighborCell(grid, 'left', 'left')).toBeNull();
    expect(neighborCell(grid, 'top-right', 'up')).toBeNull();
    expect(neighborCell(grid, 'gone', 'right')).toBeNull();
  });

  test('a cell in line wins over a nearer one off the line', () => {
    const row: CellBox[] = [
      { id: 'a', left: 0, top: 300, width: 300, height: 200 },
      { id: 'in-line', left: 700, top: 300, width: 300, height: 200 },
      { id: 'off-line', left: 350, top: 0, width: 300, height: 150 },
    ];
    expect(neighborCell(row, 'a', 'right')).toBe('in-line');
  });
});
