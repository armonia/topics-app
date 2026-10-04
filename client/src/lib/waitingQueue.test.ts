/**
 * ⌘J's queue and step, as pure functions (CHAT-WAIT-03, modified by
 * notifications-redesign, tasks.md 1.13).
 *
 * The queue is the list of rows whose attention subject is `needs-you` with a
 * question, a permission or a plan, in the order the sidebar shows them:
 * pinned first, then the "needs-you" section. The step picks the next one
 * from the focused row, and after an answer from the row the previous step
 * left, which by then has left the queue.
 *
 * Items are built as in `sidebarStateGroups.test.ts`: the subject (topic id,
 * bare terminal session id) is what the queue returns, never the render key.
 *
 * @covers CHAT-WAIT-03, CHAT-WAIT-04
 */
import { describe, test, expect } from 'bun:test';
import type { SidebarItem } from './buildSidebarItems';
import { nextWaiting, waitingQueue } from './waitingQueue';
import type { AttentionReason, AttentionSnapshot } from '../../../shared/attention';
import type { AttentionRows } from '../state/attention';

function snap(subject: string, over: Partial<AttentionSnapshot>): AttentionSnapshot {
  return {
    subject, state: 'idle', reason: null, outcome: null, detail: null, since: '2026-10-03T10:00:00.000Z',
    epoch: 1, seenEpoch: 0, lit: false, unread: 0, turnUnseen: false, lastTurnAt: null, background: [], ...over,
  };
}

/** Chats (`topic:`) waiting on `reason`, by topic id; `t:` ids are terminals. */
function waiting(reason: AttentionReason, ...ids: string[]): AttentionSnapshot[] {
  return ids.map((id) => snap(id.startsWith('t:') ? `terminal:${id.slice(2)}` : `topic:${id}`, { state: 'needs-you', reason, lit: true }));
}

const rowsOf = (...groups: AttentionSnapshot[][]): AttentionRows => new Map(groups.flat().map((r) => [r.subject, r]));

function chat(topicId: string, opts: { pinned?: boolean; subAgents?: SidebarItem[] } = {}): SidebarItem {
  return {
    id: topicId,
    type: 'chat',
    name: topicId,
    icon: '',
    lastActivity: 0,
    notificationCount: 0,
    archived: false,
    topic: { id: topicId, name: topicId } as SidebarItem['topic'],
    ...(opts.pinned ? { pinned: true } : {}),
    ...(opts.subAgents ? { subAgents: opts.subAgents } : {}),
  };
}

function terminal(sessionId: string): SidebarItem {
  return {
    id: `terminal:${sessionId}`,
    type: 'terminal',
    name: sessionId,
    icon: 'terminal',
    lastActivity: 0,
    notificationCount: 0,
    archived: false,
    terminal: { id: sessionId, name: sessionId } as SidebarItem['terminal'],
  };
}

function project(path: string, children: SidebarItem[], opts: { pinned?: boolean } = {}): SidebarItem {
  return {
    id: `project:${path}`, type: 'project', name: path, icon: '', lastActivity: 0,
    notificationCount: 0, archived: false, projectPath: path, children,
    ...(opts.pinned ? { pinned: true } : {}),
  };
}

const subjects = (items: SidebarItem[], pinnedIds: string[], rows: AttentionRows) =>
  waitingQueue(items, pinnedIds, rows).map(t => t.subject);

describe('waitingQueue: the rows that wait for an answer, in sidebar order', () => {
  test('pinned first, then the needs-you section, with a project child in its project\'s place', () => {
    // L sits above the project in the list, so it comes before P even though
    // P is the project's child: the section keeps the builder's order and
    // promotes children where their project stands.
    const items = [chat('F', { pinned: true }), chat('L'), project('/p', [chat('P')])];
    expect(subjects(items, ['F'], rowsOf(waiting('question', 'F', 'L', 'P')))).toEqual(['F', 'L', 'P']);
  });

  test('the pinned order is the Pinned block\'s, not the list\'s', () => {
    const items = [chat('A', { pinned: true }), chat('B', { pinned: true })];
    expect(subjects(items, ['B', 'A'], rowsOf(waiting('question', 'A', 'B')))).toEqual(['B', 'A']);
  });

  test('a chat pinned inside a project counts once, among the Pinned', () => {
    // The Pinned block takes pinned children, and the state grouping promotes
    // the same child without looking at `pinned`: without the dedup the door
    // would say 3 and a step from X would land on X again.
    const x = chat('X', { pinned: true });
    const items = [chat('A'), project('/p', [x])];
    const queue = waitingQueue(items, ['X'], rowsOf(waiting('permission', 'X', 'A')));
    expect(queue.map(t => t.subject)).toEqual(['X', 'A']);
    expect(queue.length).toBe(2);
  });

  test('a chat waiting inside a pinned project comes in its project\'s pinned place', () => {
    // The pinned project is drawn at the top with its tabs in its band, and
    // the list below leaves it out: skipped here, its amber chat would never
    // be a target nor a number on the door.
    const items = [chat('A'), project('/p', [chat('Q')], { pinned: true })];
    expect(subjects(items, ['project:/p'], rowsOf(waiting('question', 'A', 'Q')))).toEqual(['Q', 'A']);
  });

  test('a finished turn is not a target, seen or not', () => {
    const items = [chat('done'), chat('err'), chat('ask')];
    const rows = rowsOf(
      [snap('topic:done', { state: 'finished', outcome: 'done', lit: true })],
      [snap('topic:err', { state: 'finished', outcome: 'error', lit: true })],
      waiting('question', 'ask'),
    );
    expect(subjects(items, [], rows)).toEqual(['ask']);
  });

  test('a chat at work, a turn or a job left running, is not a target', () => {
    const items = [chat('w'), chat('bg'), chat('ask')];
    const rows = rowsOf(
      [snap('topic:w', { state: 'working' })],
      [snap('topic:bg', { state: 'working', background: [{ id: 'b', kind: 'bash', label: 'x', startedAt: '' }] })],
      waiting('question', 'ask'),
    );
    expect(subjects(items, [], rows)).toEqual(['ask']);
  });

  test('the native runtime\'s plan to approve is a target', () => {
    expect(subjects([chat('plan')], [], rowsOf(waiting('plan', 'plan')))).toEqual(['plan']);
  });

  test('a seen question is still a target: the look does not answer it', () => {
    const rows = rowsOf([snap('topic:q', { state: 'needs-you', reason: 'question', lit: true, epoch: 2, seenEpoch: 2 })]);
    expect(subjects([chat('q')], [], rows)).toEqual(['q']);
  });

  test('a Claude Code terminal parked on a permission is a target, in its row\'s place', () => {
    const items = [chat('a'), terminal('s1'), chat('b')];
    const queue = waitingQueue(items, [], rowsOf(waiting('question', 'a', 'b'), waiting('permission', 't:s1')));
    expect(queue.map(t => t.subject)).toEqual(['a', 's1', 'b']);
    expect(queue[1].kind).toBe('terminal');
  });

  test('a terminal whose turn is finished is not a target', () => {
    const rows = rowsOf([snap('terminal:s1', { state: 'finished', outcome: 'done', lit: true })]);
    expect(subjects([terminal('s1')], [], rows)).toEqual([]);
  });

  test('a sub-agent nested under a chat is not a target', () => {
    const items = [chat('parent', { subAgents: [terminal('child')] })];
    expect(subjects(items, [], rowsOf(waiting('permission', 't:child')))).toEqual([]);
  });
});

describe('nextWaiting: the step', () => {
  test('the one after the focused one', () => {
    expect(nextWaiting(['A', 'B', 'C'], 'B', null)).toBe('C');
  });

  test('after the last it starts over', () => {
    expect(nextWaiting(['A', 'B', 'C'], 'C', null)).toBe('A');
  });

  test('focus outside the queue and no previous step: the first', () => {
    expect(nextWaiting(['A', 'B'], 'working', null)).toBe('A');
    expect(nextWaiting(['A', 'B'], null, null)).toBe('A');
  });

  test('after an answer it goes forward, not back', () => {
    // The last step took you to B; you answered, B left the queue, and the
    // focus is still on B.
    expect(nextWaiting(['A', 'C'], 'B', { queue: ['A', 'B', 'C'], target: 'B' })).toBe('C');
  });

  test('after an answer with nothing left after it: the first', () => {
    expect(nextWaiting(['A'], 'C', { queue: ['A', 'B', 'C'], target: 'C' })).toBe('A');
  });

  test('a previous step is irrelevant once the focus moved elsewhere', () => {
    expect(nextWaiting(['A', 'C'], 'other', { queue: ['A', 'B', 'C'], target: 'B' })).toBe('A');
  });

  test('no other target: null', () => {
    expect(nextWaiting(['A'], 'A', null)).toBe(null);
    expect(nextWaiting([], 'A', null)).toBe(null);
    expect(nextWaiting([], null, null)).toBe(null);
  });
});
