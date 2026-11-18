/** @covers KANBAN-107 */
import { describe, expect, test } from 'bun:test';
import type { BoardTask } from '../../lib/board';
import type { BoardFilters } from './constants';
import { countQuickFilters, countQuickFiltersWithoutCreator, taskMatchesQuick } from './quickFilters';

const task = (over: Partial<BoardTask>): BoardTask => ({ id: 'x', status: 'in_progress', ...over }) as BoardTask;

describe('quick filters', () => {
  test('jarvis is an agent card, and agents include it', () => {
    const t = task({ createdBy: 'agent:jarvis' });
    expect(taskMatchesQuick(t, 'jarvis')).toBe(true);
    expect(taskMatchesQuick(t, 'agents')).toBe(true);
    expect(taskMatchesQuick(task({ createdBy: 'human' }), 'agents')).toBe(false);
  });
  test('a card with a Jarvis channel counts as Jarvis and agent without createdBy', () => {
    const t = task({ createdBy: null, channel: { topicId: 't1', name: 'x', kind: 'discord' } });
    expect(taskMatchesQuick(t, 'jarvis')).toBe(true);
    expect(taskMatchesQuick(t, 'agents')).toBe(true);
  });
  test('an API-created card counts as Jarvis', () => {
    expect(taskMatchesQuick(task({ createdBy: 'agent:api' }), 'jarvis')).toBe(true);
  });
  test('scheduled covers cron cards and cards with a scheduled run', () => {
    expect(taskMatchesQuick(task({ createdBy: 'cron:nightly' }), 'scheduled')).toBe(true);
    expect(taskMatchesQuick(task({ scheduled: { by: 'Jarvis', at: null } }), 'scheduled')).toBe(true);
    expect(taskMatchesQuick(task({}), 'scheduled')).toBe(false);
  });
  test('«me» matches only cards waiting on the person, and the counts agree', () => {
    const waiting = task({ id: 'a', status: 'review', humanAsk: 'ok?' });
    const busy = task({ id: 'b' });
    expect(taskMatchesQuick(waiting, 'me')).toBe(true);
    expect(taskMatchesQuick(busy, 'me')).toBe(false);
    expect(countQuickFilters([waiting, busy]).me).toBe(1);
  });
  test('counts ignore the creator toggle: «mine» does not zero Jarvis and Agents', () => {
    const tasks = [task({ id: 'a', createdBy: 'agent:api' }), task({ id: 'b', createdBy: 'agent:attilio' }), task({ id: 'c', createdBy: 'human' })];
    const filters = { priority: [], assignedTo: [], person: [], computer: [], initiator: [], runComputer: [], text: '', projectId: [], labels: [], creator: 'mine' } as unknown as BoardFilters;
    const counts = countQuickFiltersWithoutCreator(tasks, filters);
    expect(counts.jarvis).toBe(1);
    expect(counts.agents).toBe(2);
  });
});
