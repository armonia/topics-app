/** @covers KANBAN-107 */
import { describe, expect, test } from 'bun:test';
import type { BoardTask } from '../../lib/board';
import { countQuickFilters, taskMatchesQuick } from './quickFilters';

const task = (over: Partial<BoardTask>): BoardTask => ({ id: 'x', status: 'in_progress', ...over }) as BoardTask;

describe('quick filters', () => {
  test('jarvis is an agent card, and agents include it', () => {
    const t = task({ createdBy: 'agent:jarvis' });
    expect(taskMatchesQuick(t, 'jarvis')).toBe(true);
    expect(taskMatchesQuick(t, 'agents')).toBe(true);
    expect(taskMatchesQuick(task({ createdBy: 'human' }), 'agents')).toBe(false);
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
});
