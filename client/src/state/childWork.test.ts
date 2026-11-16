/**
 * @covers KANBAN-63
 */
import { describe, expect, test } from 'bun:test';
import { indexChildren } from './childWork';
import type { ChildAgentRow } from '../../../shared/live-work';

const row = (id: string, state: ChildAgentRow['state']): ChildAgentRow => ({
  kind: 'agent', id, name: id, runtime: 'cli', state, preview: '', startedAt: '2026-11-15T10:00:00Z', parentTopicId: 'p1',
});

describe('indexChildren', () => {
  test('keys the children at work by id and leaves the ended ones out', () => {
    const m = indexChildren([row('a', 'working'), row('b', 'waiting'), row('c', 'ended')]);
    expect([...m.keys()]).toEqual(['a', 'b']);
  });
  test('no child at work is always the same empty map', () => {
    expect(indexChildren([])).toBe(indexChildren([row('c', 'ended')]));
  });
});
