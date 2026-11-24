/**
 * @covers TABPOS-02
 */
import { describe, expect, test } from 'bun:test';
import { agedOutChats, closedProjectChatIds, closedRowRecords, rowCommand } from './closedRows';
import type { ClosedTabRecord } from '../state/pane/adapters/closedTabRecord';
import type { Topic } from '../types';

function record(id: string, type: string, closedAt: number, extra: Partial<ClosedTabRecord> = {}): ClosedTabRecord {
  return {
    id,
    closedAt,
    pane: { id, type, title: id, ...(type === 'chat' ? { topicId: id } : {}) } as ClosedTabRecord['pane'],
    groupId: 'group:default',
    groupIndex: 0,
    level: 'app',
    ...extra,
  };
}

const live = (id: string, extra: Partial<Topic> = {}) => ({ id, name: id, archived: false, ...extra }) as Topic;

describe('closedRowRecords: one closed row per closed top-level tab', () => {
  test('every kind of tab gets its closed row, newest first', () => {
    const out = closedRowRecords([
      record('t1', 'chat', 1),
      record('project:%2Fa', 'project', 5),
      record('terminal:s1', 'terminal', 3),
      record('browser:b1', 'browser', 4),
      record('__dashboard__', 'dashboard', 2),
    ], { openIds: new Set(), topics: { t1: live('t1') } });
    expect(out.map((r) => r.id)).toEqual(['project:%2Fa', 'browser:b1', 'terminal:s1', '__dashboard__', 't1']);
  });

  test('a tab open again has no closed row, and a tab closed twice has one', () => {
    const out = closedRowRecords([
      record('browser:b1', 'browser', 1),
      record('browser:b1', 'browser', 9),
      record('browser:b2', 'browser', 2),
    ], { openIds: new Set(['browser:b2']), topics: {} });
    expect(out.map((r) => [r.id, r.closedAt])).toEqual([['browser:b1', 9]]);
  });

  test('archived, unknown and coordinator chats are not closed rows', () => {
    const out = closedRowRecords([
      record('gone', 'chat', 1),
      record('arch', 'chat', 2),
      record('coord', 'chat', 3),
      record('ok', 'chat', 4),
    ], {
      openIds: new Set(),
      topics: { arch: live('arch', { archived: true }), coord: live('coord', { isGlobalOrchestrator: true } as Partial<Topic>), ok: live('ok') },
    });
    expect(out.map((r) => r.id)).toEqual(['ok']);
  });

  test('tabs inside a project window and utilities without a row stay out', () => {
    const out = closedRowRecords([
      record('browser:in', 'browser', 1, { level: 'project', projectPath: '/a' }),
      record('__board__', 'board', 2),
      record('__automations__', 'automations', 3),
      record('__features__', 'features', 4),
    ], { openIds: new Set(), topics: {} });
    expect(out).toEqual([]);
  });
});

describe('rowCommand: open closes, closed archives, archived restores', () => {
  test('the three states', () => {
    expect(rowCommand({ open: true, archived: false })).toBe('close');
    expect(rowCommand({ open: false, archived: false })).toBe('archive');
    expect(rowCommand({ open: false, archived: true })).toBe('restore');
  });
});

describe('closedProjectChatIds: a chat closed inside a project window', () => {
  const inner = (id: string, closedAt: number) =>
    record(`chat:${id}`, 'chat', closedAt, { level: 'project', projectPath: '/p', topicId: id });

  test('stays as a closed row while it is live, not archived and not open again', () => {
    const out = closedProjectChatIds(
      [inner('a', 1), inner('b', 2), inner('c', 3), inner('d', 4), record('e', 'chat', 5)],
      { openIds: new Set(['chat:c']), topics: { a: live('a'), b: live('b', { archived: true }), c: live('c'), e: live('e') } },
    );
    // b archived, c open again, d unknown, e is a top-level record.
    expect([...out]).toEqual(['a']);
  });
});

describe('agedOutChats: the FIFO drops a closed chat, it is archived', () => {
  const stack = (n: number, from = 0) => Array.from({ length: n }, (_, i) => record(`t${from + i}`, 'chat', from + i));

  test('the oldest records dropped by one close are the chats to archive', () => {
    const prev = stack(4);
    const next = [...prev.slice(1), record('t9', 'chat', 9)];
    expect(agedOutChats(prev, next, 4)).toEqual(['t0']);
  });

  test('a chat closed again later still has its row: not archived', () => {
    const prev = stack(4);
    const next = [...prev.slice(1), record('t0', 'chat', 9)];
    expect(agedOutChats(prev, next, 4)).toEqual([]);
  });

  test('below the cap nothing ages out, and a different snapshot is not an eviction', () => {
    expect(agedOutChats(stack(3), stack(3, 1), 4)).toEqual([]);
    expect(agedOutChats(stack(4), stack(4, 10), 4)).toEqual([]);
  });

  test('a terminal or browser record that falls off archives nothing', () => {
    const prev = [record('terminal:s1', 'terminal', 0), ...stack(3, 1)];
    const next = [...prev.slice(1), record('t9', 'chat', 9)];
    expect(agedOutChats(prev, next, 4)).toEqual([]);
  });
});
