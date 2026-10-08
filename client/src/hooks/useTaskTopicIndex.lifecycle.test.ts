/**
 * The topic -> task index across a topic's life, read where the app reads it.
 *
 * `useTaskTopicIndex` (mounted once in `App`) fills `state/taskSessions`, and
 * every surface asks that store "which task runs in this topic?". Since
 * `cloud-quality-pass` T2 the hook no longer re-renders on each store write:
 * it subscribes a plain callback. The independent check (V2) of that change:
 * a topic that gets a task, moves to another task, loses it, or was already
 * in the store before the hook mounted must each reach `getTopicTask` - with
 * the hook before T2 and with the hook after it.
 *
 * @covers KANBAN-01
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { mount } from '../test/reactHarness';
import type { BoardTask } from '../lib/board';
import { __resetBoardTasks, setBoardTasks } from '../lib/boardTasksStore';
import { __resetTaskSessions, getTopicTask } from '../state/taskSessions';
import { useTaskTopicIndex } from './useTaskTopicIndex';

const row = (id: string, over: Partial<BoardTask> = {}): BoardTask =>
  ({ id, projectId: 'p1', text: id, status: 'todo', kanbanOrder: 0, parentTaskId: null, assignedTopicId: null, dispatchState: null, ...over } as BoardTask);

const Host = (): null => { useTaskTopicIndex(); return null; };

afterEach(() => { __resetBoardTasks(); __resetTaskSessions(); });

describe('useTaskTopicIndex across a topic life', () => {
  test('a topic that gets a task, changes task and loses it', () => {
    const h = mount(createElement(Host));
    setBoardTasks([row('t1'), row('t2')]);
    expect(getTopicTask('topic-1')).toBeUndefined();

    setBoardTasks([row('t1', { assignedTopicId: 'topic-1', dispatchState: 'working' }), row('t2')]);
    expect(getTopicTask('topic-1')?.taskId).toBe('t1');

    setBoardTasks([row('t1'), row('t2', { assignedTopicId: 'topic-1', dispatchState: 'starting' })]);
    expect(getTopicTask('topic-1')?.taskId).toBe('t2');
    expect(getTopicTask('topic-1')?.dispatchState).toBe('starting');

    setBoardTasks([row('t1'), row('t2')]);
    expect(getTopicTask('topic-1')).toBeUndefined();
    h.unmount();
  });

  test('a task that leaves the board takes its topic with it', () => {
    const h = mount(createElement(Host));
    setBoardTasks([row('t1', { assignedTopicId: 'topic-1' }), row('t2', { assignedTopicId: 'topic-2' })]);
    setBoardTasks([row('t2', { assignedTopicId: 'topic-2' })]);
    expect(getTopicTask('topic-1')).toBeUndefined();
    expect(getTopicTask('topic-2')?.taskId).toBe('t2');
    h.unmount();
  });

  test('rows already in the store before the hook mounts are indexed at mount', () => {
    setBoardTasks([row('t1', { assignedTopicId: 'topic-1', status: 'in_progress' })]);
    const h = mount(createElement(Host));
    expect(getTopicTask('topic-1')?.status).toBe('in_progress');
    h.unmount();
  });

  test('the title of the task reaches the topic without a change of task', () => {
    const h = mount(createElement(Host));
    setBoardTasks([row('t1', { assignedTopicId: 'topic-1' })]);
    setBoardTasks([row('t1', { assignedTopicId: 'topic-1', text: 'renamed' })]);
    expect(getTopicTask('topic-1')?.text).toBe('renamed');
    h.unmount();
  });
});
