/**
 * The board's views (kanban, list, by owner, workflow) and how their stored value reads back.
 *
 * @covers KANBAN-108
 */
import { describe, expect, test } from 'bun:test';
import { DETAIL_LEVELS, parseDetailLevel } from './detailLevel';

describe('board views', () => {
  test('five entries, kanban first', () => {
    expect(DETAIL_LEVELS).toEqual(['grid', 'list', 'table', 'plan', 'workflow']);
  });
  test('stored values from before the selector still read back, the retired summary falls to the kanban', () => {
    expect(parseDetailLevel('list')).toBe('list');
    expect(parseDetailLevel('table')).toBe('table');
    expect(parseDetailLevel('plan')).toBe('plan');
    expect(parseDetailLevel('workflow')).toBe('workflow');
    expect(parseDetailLevel('summary')).toBe('grid');
    expect(parseDetailLevel(null)).toBe('grid');
  });
});
