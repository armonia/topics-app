/**
 * Detail slider levels (projects summary, list, kanban).
 *
 * @covers KANBAN-108
 */
import { describe, expect, test } from 'bun:test';
import { DETAIL_LEVELS, countByProject, detailAtFraction, parseDetailLevel, stepDetail } from './detailLevel';

describe('detail levels', () => {
  test('stored values from before the summary level still read back', () => {
    expect(parseDetailLevel('list')).toBe('list');
    expect(parseDetailLevel('summary')).toBe('summary');
    expect(parseDetailLevel(null)).toBe('grid');
  });

  test('steps clamp at both ends', () => {
    expect(stepDetail('summary', -1, DETAIL_LEVELS)).toBe('summary');
    expect(stepDetail('summary', 1, DETAIL_LEVELS)).toBe('list');
    expect(stepDetail('grid', 1, DETAIL_LEVELS)).toBe('plan');
    expect(stepDetail('plan', 1, DETAIL_LEVELS)).toBe('plan');
    expect(stepDetail('grid', 1, ['summary', 'list', 'grid'])).toBe('grid');
  });

  test('the pointer snaps to the nearest stop', () => {
    expect(detailAtFraction(-1, DETAIL_LEVELS)).toBe('summary');
    expect(detailAtFraction(0.4, DETAIL_LEVELS)).toBe('list');
    expect(detailAtFraction(0.7, DETAIL_LEVELS)).toBe('grid');
    expect(detailAtFraction(0.9, DETAIL_LEVELS)).toBe('plan');
  });

  test('counts per project and column, busiest first', () => {
    const rows = countByProject([[{ projectId: 'a-1' }, { projectId: 'b-1' }], [{ projectId: 'b-1' }]]);
    expect(rows.map((r) => [r.label, r.total, r.perColumn])).toEqual([['b', 2, [1, 1]], ['a', 1, [1, 0]]]);
  });
});
