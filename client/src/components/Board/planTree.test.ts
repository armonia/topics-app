import { describe, expect, test } from 'bun:test';
import { milestoneChoices, nodeKey, progressLabel, progressPct, subtreeSignals } from './planTree';
import type { PlanProject } from './planApi';

describe('planTree', () => {
  test('progressPct rounds and never divides by zero', () => {
    expect(progressPct({ total: 0, done: 0 })).toBe(0);
    expect(progressPct({ total: 3, done: 1 })).toBe(33);
    expect(progressPct({ total: 2, done: 2 })).toBe(100);
  });
  test('progressLabel', () => expect(progressLabel({ total: 8, done: 3 })).toBe('3/8'));
  test('milestoneChoices flattens areas in tree order', () => {
    const p = { areas: [
      { name: 'A', milestones: [{ id: 'm1', title: 'X' }, { id: 'm2', title: 'Y' }] },
      { name: 'B', milestones: [{ id: 'm3', title: 'Z' }] },
    ] } as unknown as PlanProject;
    expect(milestoneChoices(p)).toEqual([{ id: 'm1', label: 'A / X' }, { id: 'm2', label: 'A / Y' }, { id: 'm3', label: 'B / Z' }]);
  });
  test('subtreeSignals dedupes', () => {
    expect(subtreeSignals([{ signals: ['stale', 'duplicate'] }, { signals: ['stale'] }])).toEqual(['stale', 'duplicate']);
  });
  test('nodeKey', () => expect(nodeKey('area', 'a1')).toBe('area:a1'));
});
