/**
 * The topic -> task index follows the board store without rendering its host.
 *
 * `useTaskTopicIndex` is mounted in `App`. It used to read the rows through
 * `useBoardTasks()`, so every write of the store (every `task:updated` an agent
 * at work re-emits) re-rendered `App` just to run an effect. The test harness
 * re-renders on every notice of a store a component subscribed to in render,
 * which is exactly the dependency this file refuses.
 *
 * @covers KANBAN-01
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createElement, useEffect } from 'react';
import { mount } from '../test/reactHarness';
import type { BoardTask } from '../lib/board';
import { __resetBoardTasks, setBoardTasks } from '../lib/boardTasksStore';
import { useTaskTopicIndex, type TopicTaskResolver } from './useTaskTopicIndex';

const row = (id: string, over: Partial<BoardTask> = {}): BoardTask =>
  ({ id, projectId: 'p1', text: id, status: 'todo', kanbanOrder: 0, parentTaskId: null, assignedTopicId: null, dispatchState: null, ...over } as BoardTask);

afterEach(() => { __resetBoardTasks(); });

describe('useTaskTopicIndex', () => {
  test('a store write updates the index and renders nobody', () => {
    let renders = 0;
    const box: { resolve: TopicTaskResolver | null } = { resolve: null };
    const Probe = (): null => {
      renders++;
      const resolve = useTaskTopicIndex();
      useEffect(() => { box.resolve = resolve; });
      return null;
    };
    const h = mount(createElement(Probe));
    const afterMount = renders;
    expect(box.resolve!('topic-1')).toBeNull();

    setBoardTasks([row('t1', { assignedTopicId: 'topic-1', dispatchState: 'working' })]);
    expect(box.resolve!('topic-1')).toEqual({ taskId: 't1', status: 'todo', dispatchState: 'working' });

    setBoardTasks([row('t1', { assignedTopicId: 'topic-1', dispatchState: null, text: 'renamed' })]);
    expect(box.resolve!('topic-1')?.dispatchState).toBeNull();
    expect(renders, 'the host re-rendered for a store write').toBe(afterMount);
    h.unmount();
  });
});
