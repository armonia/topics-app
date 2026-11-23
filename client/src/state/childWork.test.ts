/**
 * @covers KANBAN-63
 * @covers SUBAGENT-16
 */
import { describe, expect, test } from 'bun:test';
import { indexChildren, shownChildState } from './childWork';
import { agentsAtWorkUnder } from '../../../shared/live-work';
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

const kid = (id: string, parentTopicId: string, state: ChildAgentRow['state']): ChildAgentRow => ({
  kind: 'agent', id, name: id, runtime: 'topics', state, preview: '', startedAt: '2026-11-23T10:00:00Z', parentTopicId,
});

describe('agentsAtWorkUnder', () => {
  // The live case of 23/11: a sub-agent waiting on three children of its own, beside a sibling at work.
  const tree = [
    kid('zeno', 'root', 'awaiting'),
    kid('ci', 'root', 'working'),
    kid('abbonamenti', 'zeno', 'working'),
    kid('prenotazioni', 'zeno', 'working'),
    kid('e2e', 'zeno', 'working'),
    kid('gone', 'zeno', 'ended'),
  ];
  test('counts every descendant whose turn is open, at any depth, and not the one that only waits', () => {
    expect(agentsAtWorkUnder(tree, 'root')).toBe(4);
    expect(agentsAtWorkUnder(tree, 'zeno')).toBe(3);
    expect(agentsAtWorkUnder(tree, 'ci')).toBe(0);
  });
  test('a cycle in bad data is visited once', () => {
    expect(agentsAtWorkUnder([kid('a', 'b', 'working'), kid('b', 'a', 'working')], 'a')).toBe(1);
  });
});

describe('shownChildState', () => {
  test('a child that waits on agents at work is drawn at work', () => {
    expect(shownChildState('awaiting', 3, [])).toBe('working');
  });
  test('a child that waits on a command of its own is drawn at work', () => {
    expect(shownChildState('awaiting', 0, [{ kind: 'command' }])).toBe('working');
  });
  test('with nothing running it stays a clock: an owed result, a wake or a recurring cron is not work (18/11)', () => {
    expect(shownChildState('awaiting', 0, [{ kind: 'subagent' }, { kind: 'wake' }, { kind: 'cron', recurring: true }])).toBe('awaiting');
  });
  test('the other states pass through', () => {
    expect(shownChildState('waiting', 2, [{ kind: 'command' }])).toBe('waiting');
    expect(shownChildState('ended', 2, [])).toBe('ended');
  });
});
