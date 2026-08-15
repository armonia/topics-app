import { describe, expect, test } from 'bun:test';
import type { BoardTask } from './board';
import { buildTopicTaskIndex } from './taskTopicIndex';

/** A BoardTask with only the fields the index looks at. */
function task(over: Partial<BoardTask> & { id: string }): BoardTask {
  return {
    projectId: 'pX', text: over.id, description: null, status: 'todo', priority: 2,
    priorityAuto: false, kanbanOrder: 0, assignedTo: null, dueDate: null,
    createdAt: '2026-01-01T00:00:00.000Z', completedAt: null, updatedAt: '2026-01-01T00:00:00.000Z',
    assignedTopicId: null, dispatchState: null, dispatchError: null, parentTaskId: null,
    outputUrl: null, previewImage: null, planFirst: false, inProgressAt: null,
    agentMs: 0, agentTokens: 0, agentCacheReadTokens: 0, subtaskCount: 0, subtaskDoneCount: 0,
    userCommentCount: 0, model: null, blockedByTaskId: null, reuseBlockerContext: false,
    deliveryBranch: null, deliveryCommit: null, landingState: null, landingCheckedAt: null,
    checksState: null, checksAt: null, checksCommit: null, checks: null,
    deliveredBy: null, deliveredReason: null,
    ...over,
  } as BoardTask;
}

describe('buildTopicTaskIndex', () => {
  test('only the DISPATCHED tasks enter: a task without a topic has no session', () => {
    const idx = buildTopicTaskIndex([
      task({ id: 't1', assignedTopicId: 'topic-1' }),
      task({ id: 't2' }),
    ]);
    expect([...idx.byTopic.keys()]).toEqual(['topic-1']);
    expect(Object.keys(idx.forStore)).toEqual(['topic-1']);
  });

  test('the entry is complete: id, column and dispatch state', () => {
    // The silencer needs `dispatchState` (is the agent working RIGHT NOW) and the
    // return line needs `text`: a bare taskId would say nothing on screen.
    const idx = buildTopicTaskIndex([
      task({ id: 't1', text: 'ship it', assignedTopicId: 'topic-1', status: 'in_progress', dispatchState: 'working' }),
    ]);
    expect(idx.byTopic.get('topic-1')).toEqual({ taskId: 't1', status: 'in_progress', dispatchState: 'working' });
    expect(idx.forStore['topic-1']).toEqual({ taskId: 't1', text: 'ship it', status: 'in_progress', dispatchState: 'working' });
  });

  test('two tasks on the same topic: the LAST row of the feed wins', () => {
    // The feed is ordered by the server; a topic reassigned to another task is
    // exactly the case where the older row must not be the one that sticks.
    const idx = buildTopicTaskIndex([
      task({ id: 'old', assignedTopicId: 'topic-1', dispatchState: 'delivered' }),
      task({ id: 'new', assignedTopicId: 'topic-1', dispatchState: 'working' }),
    ]);
    expect(idx.byTopic.get('topic-1')?.taskId).toBe('new');
    expect(idx.forStore['topic-1'].dispatchState).toBe('working');
  });

  test('an empty feed produces an empty index, not a throw', () => {
    const idx = buildTopicTaskIndex([]);
    expect(idx.byTopic.size).toBe(0);
    expect(idx.forStore).toEqual({});
  });
});
