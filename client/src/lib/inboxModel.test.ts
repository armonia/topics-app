/**
 * `inboxModel`: what the «To look at» panel lists (ATTN-09, tasks.md 4.2 and
 * 4.3). The panel only draws this, so the contract lives here: the two
 * sections and their order, the epochs «Mark seen» and «Mark all seen» send,
 * and the quiet line that never turns into a number.
 *
 * @covers ATTN-09, NOTIF-ONE-02
 */
import { describe, test, expect } from 'bun:test';
import { historyDayKey, inboxModel, markAllSeenItems } from './inboxModel';
import { chromeAttentionTotal } from '../state/attentionTotal';
import type { AttentionSnapshot } from '../../../shared/attention';
import type { Topic, TerminalSessionInfo } from '../types';

const topic = (id: string, over: Partial<Topic> = {}): Topic => ({ id, name: `chat ${id}`, ...over } as Topic);
const term = (id: string): TerminalSessionInfo =>
  ({ id, name: `term ${id}`, createdAt: new Date(0).toISOString(), cwd: '/w/alpha', command: 'claude', clients: 1, type: 'claude-code' });

function snap(subject: string, over: Partial<AttentionSnapshot> = {}): AttentionSnapshot {
  return {
    subject, state: 'idle', reason: null, outcome: null, detail: null, since: '2026-10-03T10:00:00.000Z',
    epoch: 1, seenEpoch: 0, lit: false, unread: 0, turnUnseen: false, lastTurnAt: null, background: [], ...over,
  };
}
const at = (minute: number) => `2026-10-03T10:${String(minute).padStart(2, '0')}:00.000Z`;
const done = (subject: string, minute: number, over: Partial<AttentionSnapshot> = {}) =>
  snap(subject, { state: 'finished', outcome: 'done', lit: true, since: at(minute), ...over });
const ask = (subject: string, minute: number, reason: AttentionSnapshot['reason'] = 'question') =>
  snap(subject, { state: 'needs-you', reason, lit: true, since: at(minute) });
const rowsOf = (...rows: AttentionSnapshot[]) => new Map(rows.map((r) => [r.subject, r]));

describe('inboxModel: «Waiting for you» and «Finished»', () => {
  const topics = { a: topic('a'), b: topic('b'), c: topic('c'), q: topic('q'), p: topic('p'), old: topic('old', { archived: true }) };
  const rows = rowsOf(
    done('topic:a', 5, { epoch: 4, lastTurnAt: '2026-10-03T10:04:00.000Z', unread: 3 }),
    done('topic:b', 9),
    done('topic:c', 7, { outcome: 'error', detail: 'boom' }),
    ask('topic:q', 8),
    ask('topic:p', 2, 'permission'),
    done('topic:old', 9),
    done('terminal:s1', 1),
    ask('task:r1', 6, 'review'),
  );
  const model = inboxModel(rows, topics, [term('s1')], [{ id: 'r1', text: 'Fix the badge\nmore text' }]);

  test('needs-you waits in its own section, the OLDEST first', () => {
    expect(model.waiting.map((i) => i.subject)).toEqual(['topic:p', 'task:r1', 'topic:q']);
  });

  test('the finished ones follow, the most RECENT first, an archived chat never', () => {
    expect(model.finished.map((i) => i.subject)).toEqual(['topic:b', 'topic:c', 'topic:a', 'terminal:s1']);
  });

  test('a row names its subject and says why: the card by its first line, the error by its tier', () => {
    expect(model.waiting.find((i) => i.subject === 'task:r1')).toMatchObject({ kind: 'card', title: 'Fix the badge', reason: 'review' });
    expect(model.finished.find((i) => i.subject === 'topic:c')).toMatchObject({ tier: 'error', detail: 'boom' });
    expect(model.finished.find((i) => i.subject === 'terminal:s1')).toMatchObject({ kind: 'terminal', title: 'term s1', url: null });
    expect(model.finished.find((i) => i.subject === 'topic:a')?.url).toBe('/topic/a');
  });

  test('«Mark seen» sends the epoch and the turn the row SHOWS', () => {
    expect(model.finished.find((i) => i.subject === 'topic:a')?.seen).toEqual({ subject: 'topic:a', epoch: 4, turnAt: '2026-10-03T10:04:00.000Z' });
  });

  test('the panel lists exactly what the chrome counts', () => {
    expect(model.waiting.length + model.finished.length).toBe(chromeAttentionTotal(rows, topics));
  });

  test('«Mark all seen» sends the finished rows only: with three finished and two waiting the number is 2', () => {
    const three = rowsOf(done('topic:a', 1), done('topic:b', 2), done('topic:c', 3), ask('topic:q', 4), ask('topic:p', 5));
    const items = markAllSeenItems(inboxModel(three, topics, [], []));
    expect(items.map((i) => i.subject).sort()).toEqual(['topic:a', 'topic:b', 'topic:c']);
    const after = new Map(three);
    for (const i of items) after.set(i.subject, { ...three.get(i.subject)!, seenEpoch: i.epoch, lit: false });
    expect(chromeAttentionTotal(after, topics)).toBe(2);
  });
});

describe('inboxModel: the quiet line', () => {
  test('nothing lit and two chats in background: both sections empty, «2 in background», no number', () => {
    const topics = { x: topic('x'), y: topic('y'), z: topic('z') };
    const task = { id: 't1', kind: 'agent', label: 'verify render', startedAt: '' };
    const rows = rowsOf(
      snap('topic:x', { state: 'background', background: [{ id: 'c', kind: 'cron', label: '*/5', startedAt: '', recurring: true }, task] }),
      snap('topic:y', { state: 'background', background: [task] }),
      snap('topic:z', { state: 'working' }),
    );
    const model = inboxModel(rows, topics, [], []);
    expect(model.waiting).toEqual([]);
    expect(model.finished).toEqual([]);
    expect(model.background.map((q) => q.subject).sort()).toEqual(['topic:x', 'topic:y']);
    expect(model.working.map((q) => q.subject)).toEqual(['topic:z']);
    expect(chromeAttentionTotal(rows, topics)).toBe(0);
  });

  test('the first task named is the first one that is not a recurring cron', () => {
    const task = { id: 't1', kind: 'agent', label: 'verify render', startedAt: '' };
    const rows = rowsOf(snap('topic:x', { state: 'background', background: [{ id: 'c', kind: 'cron', label: '*/5', startedAt: '', recurring: true }, task] }));
    expect(inboxModel(rows, { x: topic('x') }, [], []).background[0]?.firstTask).toEqual(task);
  });
});

describe('historyDayKey: the «History» tab groups by day', () => {
  const now = new Date(2026, 9, 3, 15, 0, 0).getTime();
  test('today, yesterday, then the local date', () => {
    expect(historyDayKey(new Date(2026, 9, 3, 0, 5).toISOString(), now)).toBe('today');
    expect(historyDayKey(new Date(2026, 9, 2, 23, 55).toISOString(), now)).toBe('yesterday');
    expect(historyDayKey(new Date(2026, 8, 28, 12, 0).toISOString(), now)).toBe('2026-09-28');
    expect(historyDayKey('not a date', now)).toBe('');
  });
});
