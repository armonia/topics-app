/**
 * THE SIDEBAR KEEPS AND ORDERS ITS ROWS BY THE LIT STATE (tasks.md 1.13,
 * ATTN-14, F5).
 *
 * A chat with no tab stays in the sidebar while its subject is lit, and the
 * lit rows sit on top, the most recent entry first. Neither the unread count
 * nor the Claude phase holds a row up: a chat that has been read goes back to
 * its place by activity, and one with no tab leaves.
 *
 * @covers ATTN-12, ATTN-14, PARITY-01
 */
import { describe, test, expect } from 'bun:test';
import { buildSidebarItems, groupSidebarItemsByState, type SidebarItem } from './buildSidebarItems';
import type { AttentionSnapshot } from '../../../shared/attention';
import type { Topic } from '../types';

function snap(subject: string, over: Partial<AttentionSnapshot> = {}): AttentionSnapshot {
  return {
    subject, state: 'idle', reason: null, outcome: null, detail: null, since: '2026-10-03T10:00:00.000Z',
    epoch: 0, seenEpoch: 0, lit: false, unread: 0, turnUnseen: false, lastTurnAt: null, background: [], ...over,
  };
}

const rowsOf = (...rows: AttentionSnapshot[]) => new Map(rows.map((r) => [r.subject, r]));

const topic = (id: string, updatedAt: string): Topic =>
  ({ id, name: id, sessionKey: `topic:${id}`, createdAt: updatedAt, updatedAt, lastMessageAt: updatedAt } as unknown as Topic);

const base = { workspaceProjects: [], browserContexts: [], terminalSessions: [], showArchived: false };

const ids = (items: SidebarItem[]) => items.map((i) => i.id);

describe('presence: a chat with no tab', () => {
  test('stays while lit, and leaves once seen, whatever its unread', () => {
    const topics = { A: topic('A', '2026-10-03T09:00:00.000Z'), B: topic('B', '2026-10-03T09:30:00.000Z') };
    const lit = rowsOf(snap('topic:A', { state: 'needs-you', reason: 'permission', epoch: 1, lit: true }));
    expect(ids(buildSidebarItems({ ...base, topics, attention: lit }))).toEqual(['A']);

    // Read: the server says seen, with unread messages still on the row of the
    // unread table. No tab, not lit: no row.
    const seen = rowsOf(snap('topic:A', { state: 'finished', outcome: 'done', epoch: 2, seenEpoch: 2, lit: false }));
    expect(ids(buildSidebarItems({ ...base, topics, attention: seen }))).toEqual([]);
  });

  test('a chat waiting on its job with unread has no number and no row of its own', () => {
    const topics = { A: topic('A', '2026-10-03T09:00:00.000Z') };
    const bg = rowsOf(snap('topic:A', { state: 'working', unread: 2, background: [{ id: 'b', kind: 'bash', label: 'x', startedAt: '' }] }));
    expect(buildSidebarItems({ ...base, topics, attention: bg, openPanels: ['A'] })[0].notificationCount).toBe(0);
  });

  test('the number is max(1, unread) of a lit chat, the same as its tab', () => {
    const topics = { A: topic('A', '2026-10-03T09:00:00.000Z'), Q: topic('Q', '2026-10-03T09:00:00.000Z') };
    const rows = rowsOf(
      snap('topic:A', { state: 'finished', outcome: 'done', epoch: 1, lit: true, unread: 3 }),
      snap('topic:Q', { state: 'needs-you', reason: 'question', epoch: 1, lit: true, unread: 0 }),
    );
    const items = buildSidebarItems({ ...base, topics, attention: rows });
    expect(Object.fromEntries(items.map((i) => [i.id, i.notificationCount]))).toEqual({ A: 3, Q: 1 });
  });
});

describe('order: lit first by entry, then activity (F5)', () => {
  test('two lit chats, A more recent than B, both above the quiet ones; seen, A goes back to its place', () => {
    const topics = {
      A: topic('A', '2026-10-03T08:00:00.000Z'),
      B: topic('B', '2026-10-03T08:10:00.000Z'),
      Q: topic('Q', '2026-10-03T09:50:00.000Z'),
    };
    const open = ['A', 'B', 'Q'];
    const lit = rowsOf(
      snap('topic:A', { state: 'finished', outcome: 'done', epoch: 1, lit: true, since: '2026-10-03T10:05:00.000Z' }),
      snap('topic:B', { state: 'finished', outcome: 'done', epoch: 1, lit: true, since: '2026-10-03T10:01:00.000Z' }),
    );
    expect(ids(buildSidebarItems({ ...base, topics, attention: lit, openPanels: open }))).toEqual(['A', 'B', 'Q']);

    const aSeen = rowsOf(
      snap('topic:A', { state: 'finished', outcome: 'done', epoch: 1, seenEpoch: 1, lit: false, since: '2026-10-03T10:05:00.000Z' }),
      snap('topic:B', { state: 'finished', outcome: 'done', epoch: 1, lit: true, since: '2026-10-03T10:01:00.000Z' }),
    );
    expect(ids(buildSidebarItems({ ...base, topics, attention: aSeen, openPanels: open }))).toEqual(['B', 'Q', 'A']);
  });
});

describe('the state view reads the tier (ATTN-12)', () => {
  test('three sections: waits for you, finished, at work (a job a closed turn left running included)', () => {
    const topics = {
      N: topic('N', '2026-10-03T08:00:00.000Z'), D: topic('D', '2026-10-03T08:00:00.000Z'), E: topic('E', '2026-10-03T08:00:00.000Z'),
      G: topic('G', '2026-10-03T08:00:00.000Z'), W: topic('W', '2026-10-03T08:00:00.000Z'), I: topic('I', '2026-10-03T08:00:00.000Z'),
    };
    const rows = rowsOf(
      snap('topic:N', { state: 'needs-you', reason: 'question', epoch: 1, lit: true }),
      snap('topic:D', { state: 'finished', outcome: 'done', epoch: 1, lit: true }),
      snap('topic:E', { state: 'finished', outcome: 'error', epoch: 1, lit: true }),
      snap('topic:G', { state: 'working', background: [{ id: 'b', kind: 'bash', label: 'x', startedAt: '' }] }),
      snap('topic:W', { state: 'working' }),
    );
    const items = buildSidebarItems({ ...base, topics, attention: rows, openPanels: Object.keys(topics) });
    const g = groupSidebarItemsByState(items, rows);
    expect({
      needsYou: ids(g['needs-you']), finished: ids(g.finished).sort(), working: ids(g.working).sort(), rest: ids(g.rest),
    }).toEqual({ needsYou: ['N'], finished: ['D', 'E'], working: ['G', 'W'], rest: ['I'] });
  });
});
