/**
 * The board's views (kanban, list, cards) and how their stored value reads back.
 *
 * @covers KANBAN-108
 */
import { describe, expect, test } from 'bun:test';
import { DETAIL_LEVELS, parseDetailLevel } from './detailLevel';

describe('board views', () => {
  test('three entries, kanban first', () => {
    expect(DETAIL_LEVELS).toEqual(['grid', 'list', 'plan']);
  });
  test('stored values from before the selector still read back, the retired summary falls to the kanban', () => {
    expect(parseDetailLevel('list')).toBe('list');
    expect(parseDetailLevel('plan')).toBe('plan');
    expect(parseDetailLevel('summary')).toBe('grid');
    expect(parseDetailLevel(null)).toBe('grid');
  });
});
