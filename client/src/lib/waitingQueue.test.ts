/**
 * ⌘J's queue and step, as pure functions (CHAT-WAIT-03).
 *
 * The queue is the list of amber rows in the order the sidebar shows them:
 * pinned first, then the «Attende te» section. The step picks the next one
 * from the focused row, and after an answer from the row the previous step
 * left, which by then has left the queue.
 *
 * Items are built as in `sidebarStateGroups.test.ts`: the subject (topic id,
 * bare terminal session id) is what the signal sets know, never the render key.
 *
 * @covers CHAT-WAIT-03, CHAT-WAIT-04
 */
import { describe, test, expect } from 'bun:test';
import type { SidebarItem, SidebarSignalSources } from './buildSidebarItems';
import { nextWaiting, waitingQueue } from './waitingQueue';

const S = (...ids: string[]): ReadonlySet<string> => new Set(ids);

const noSignals: SidebarSignalSources = {
  awaitingFeedbackTopics: S(),
  awaitingInputTopics: S(),
  claudePhaseAwaitingTermIds: S(),
  claudePhaseAwaitingInputTermIds: S(),
  liveStreamTopics: S(),
  hydratedStreamTopics: S(),
  claudePhaseActiveTermIds: S(),
};

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

const subjects = (items: SidebarItem[], pinnedIds: string[], sig: SidebarSignalSources) =>
  waitingQueue(items, pinnedIds, sig).map(t => t.subject);

describe('waitingQueue: the amber rows, in sidebar order', () => {
  test('pinned first, then «Attende te», with a project child in its project\'s place', () => {
    // L sits above the project in the list, so it comes before P even though
    // P is the project's child: the section keeps the builder's order and
    // promotes children where their project stands.
    const items = [chat('F', { pinned: true }), chat('L'), project('/p', [chat('P')])];
    const sig = { ...noSignals, awaitingInputTopics: S('F', 'L', 'P') };
    expect(subjects(items, ['F'], sig)).toEqual(['F', 'L', 'P']);
  });

  test('the pinned order is the Pinned block\'s, not the list\'s', () => {
    const items = [chat('A', { pinned: true }), chat('B', { pinned: true })];
    const sig = { ...noSignals, awaitingInputTopics: S('A', 'B') };
    expect(subjects(items, ['B', 'A'], sig)).toEqual(['B', 'A']);
  });

  test('a chat pinned inside a project counts once, among the Pinned', () => {
    // The Pinned block takes pinned children, and the state grouping promotes
    // the same child without looking at `pinned`: without the dedup the door
    // would say 3 and a step from X would land on X again.
    const x = chat('X', { pinned: true });
    const items = [chat('A'), project('/p', [x])];
    const queue = waitingQueue(items, ['X'], { ...noSignals, awaitingInputTopics: S('X', 'A') });
    expect(queue.map(t => t.subject)).toEqual(['X', 'A']);
    expect(queue.length).toBe(2);
  });

  test('a chat waiting inside a pinned project comes in its project\'s pinned place', () => {
    // The pinned project is drawn at the top with its tabs in its band, and
    // the list below leaves it out: skipped here, its amber chat would never
    // be a target nor a number on the door.
    const items = [chat('A'), project('/p', [chat('Q')], { pinned: true })];
    const sig = { ...noSignals, awaitingInputTopics: S('A', 'Q') };
    expect(subjects(items, ['project:/p'], sig)).toEqual(['Q', 'A']);
  });

  test('a finished turn is not a target', () => {
    // Blue, not amber: it exists only for sessions with hooks, and taking it
    // would make ⌘J behave in two ways depending on the runtime.
    const items = [chat('done'), chat('ask')];
    const sig = { ...noSignals, awaitingFeedbackTopics: S('done'), awaitingInputTopics: S('ask') };
    expect(subjects(items, [], sig)).toEqual(['ask']);
  });

  test('a working chat is not a target', () => {
    const items = [chat('w'), chat('ask')];
    const sig = { ...noSignals, liveStreamTopics: S('w', 'ask'), awaitingInputTopics: S('ask') };
    expect(subjects(items, [], sig)).toEqual(['ask']);
  });

  test('a Claude Code terminal parked on a permission is a target, in its row\'s place', () => {
    const items = [chat('a'), terminal('s1'), chat('b')];
    const sig = {
      ...noSignals,
      awaitingInputTopics: S('a', 'b'),
      claudePhaseAwaitingTermIds: S('s1'),
      claudePhaseAwaitingInputTermIds: S('s1'),
    };
    const queue = waitingQueue(items, [], sig);
    expect(queue.map(t => t.subject)).toEqual(['a', 's1', 'b']);
    expect(queue[1].kind).toBe('terminal');
  });

  test('a terminal whose turn is finished is not a target', () => {
    const items = [terminal('s1')];
    const sig = { ...noSignals, claudePhaseAwaitingTermIds: S('s1') };
    expect(subjects(items, [], sig)).toEqual([]);
  });

  test('a sub-agent nested under a chat is not a target', () => {
    const items = [chat('parent', { subAgents: [terminal('child')] })];
    const sig = { ...noSignals, claudePhaseAwaitingTermIds: S('child'), claudePhaseAwaitingInputTermIds: S('child') };
    expect(subjects(items, [], sig)).toEqual([]);
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
