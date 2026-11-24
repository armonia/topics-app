/**
 * @covers TABPOS-02
 */
import { describe, expect, test } from 'bun:test';
import { closedRowRecords, rowCommand } from './closedRows';
import type { ClosedTabRecord } from '../state/pane/adapters/closedTabRecord';
import type { Topic } from '../types';

function rec(id: string, type: string, closedAt: number, extra: Partial<ClosedTabRecord> = {}): ClosedTabRecord {
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
      rec('t1', 'chat', 1),
      rec('project:%2Fa', 'project', 5),
      rec('terminal:s1', 'terminal', 3),
      rec('browser:b1', 'browser', 4),
      rec('__dashboard__', 'dashboard', 2),
    ], { openIds: new Set(), topics: { t1: live('t1') } });
    expect(out.map((r) => r.id)).toEqual(['project:%2Fa', 'browser:b1', 'terminal:s1', '__dashboard__', 't1']);
  });

  test('a tab open again has no closed row, and a tab closed twice has one', () => {
    const out = closedRowRecords([
      rec('browser:b1', 'browser', 1),
      rec('browser:b1', 'browser', 9),
      rec('browser:b2', 'browser', 2),
    ], { openIds: new Set(['browser:b2']), topics: {} });
    expect(out.map((r) => [r.id, r.closedAt])).toEqual([['browser:b1', 9]]);
  });

  test('archived, unknown and coordinator chats are not closed rows', () => {
    const out = closedRowRecords([
      rec('gone', 'chat', 1),
      rec('arch', 'chat', 2),
      rec('coord', 'chat', 3),
      rec('ok', 'chat', 4),
    ], {
      openIds: new Set(),
      topics: { arch: live('arch', { archived: true }), coord: live('coord', { isGlobalOrchestrator: true } as Partial<Topic>), ok: live('ok') },
    });
    expect(out.map((r) => r.id)).toEqual(['ok']);
  });

  test('tabs inside a project window and utilities without a row stay out', () => {
    const out = closedRowRecords([
      rec('browser:in', 'browser', 1, { level: 'project', projectPath: '/a' }),
      rec('__board__', 'board', 2),
      rec('__automations__', 'automations', 3),
      rec('__features__', 'features', 4),
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
