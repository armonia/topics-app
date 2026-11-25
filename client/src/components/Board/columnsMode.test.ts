/**
 * The columns preference: parsing and the merged order of «one column».
 *
 * @covers KANBAN-121
 */
import { describe, expect, test } from 'bun:test';
import { mergeInColumnOrder, parseColumnsMode, viewHasColumns } from './columnsMode';

describe('parseColumnsMode', () => {
  test('only «single» switches the merge on', () => {
    expect(parseColumnsMode('single')).toBe('single');
    expect(parseColumnsMode('split')).toBe('split');
    expect(parseColumnsMode('nonsense')).toBe('split');
    expect(parseColumnsMode(null)).toBe('split');
    expect(parseColumnsMode(undefined)).toBe('split');
  });
});

describe('viewHasColumns', () => {
  test('the kanban and the list merge, the cards and workflow views do not', () => {
    expect(viewHasColumns('grid')).toBe(true);
    expect(viewHasColumns('list')).toBe(true);
    expect(viewHasColumns('plan')).toBe(false);
    expect(viewHasColumns('workflow')).toBe(false);
  });
});

describe('mergeInColumnOrder', () => {
  const columns = [{ id: 'todo' }, { id: 'in_progress' }, { id: 'review' }];
  const byColumn = new Map([
    ['todo', [{ id: 't1' }, { id: 't2' }]],
    ['in_progress', [{ id: 'p1' }]],
    ['review', [{ id: 'r1' }, { id: 'r2' }]],
  ]);

  test('column order first, then the board order inside each column', () => {
    expect(mergeInColumnOrder(columns, byColumn).map((t) => t.id)).toEqual(['t1', 't2', 'p1', 'r1', 'r2']);
  });

  test('a group narrows it to its own ids, order kept', () => {
    const ids = new Set(['r2', 't2', 'p1']);
    expect(mergeInColumnOrder(columns, byColumn, ids).map((t) => t.id)).toEqual(['t2', 'p1', 'r2']);
  });

  test('a hidden column (not in the shown list) contributes nothing, a missing one is skipped', () => {
    expect(mergeInColumnOrder([{ id: 'review' }, { id: 'done' }], byColumn).map((t) => t.id)).toEqual(['r1', 'r2']);
  });
});
