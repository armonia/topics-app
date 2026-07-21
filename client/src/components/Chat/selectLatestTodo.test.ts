import { describe, expect, test } from 'bun:test';
import { selectLatestTodo } from './selectLatestTodo';
import type { ChatMessage, ToolCall } from '../../types';

function todoCall(id: string, items: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string }>): ToolCall {
  return { id, name: 'TodoWrite', args: { todos: items }, status: 'success', detail: { type: 'todo', items } };
}

function asstWith(calls: ToolCall[]): ChatMessage {
  return { id: `m_${Math.random()}`, role: 'assistant', content: '', timestamp: new Date().toISOString(), toolCalls: calls };
}

describe('selectLatestTodo', () => {
  test('returns null when there are no todos', () => {
    expect(selectLatestTodo([])).toBeNull();
    expect(selectLatestTodo([{ id: 'u', role: 'user', content: 'hi', timestamp: '' }])).toBeNull();
  });

  test('picks the most recent TodoWrite', () => {
    const messages: ChatMessage[] = [
      asstWith([todoCall('t1', [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }])]),
      asstWith([todoCall('t2', [
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'in_progress', activeForm: 'Doing b' },
        { content: 'c', status: 'pending' },
      ])]),
    ];
    const snap = selectLatestTodo(messages)!;
    expect(snap.total).toBe(3);
    expect(snap.done).toBe(1);
    expect(snap.active?.activeForm).toBe('Doing b');
  });

  test('scans within a message newest-call-first', () => {
    const msg = asstWith([
      todoCall('t1', [{ content: 'old', status: 'pending' }]),
      todoCall('t2', [{ content: 'new1', status: 'completed' }, { content: 'new2', status: 'pending' }]),
    ]);
    const snap = selectLatestTodo([msg])!;
    expect(snap.total).toBe(2);
    expect(snap.items[0].content).toBe('new1');
  });

  test('an empty latest todo list pins nothing', () => {
    expect(selectLatestTodo([asstWith([todoCall('t', [])])])).toBeNull();
  });

  test('ignores non-todo tool calls', () => {
    const msg = asstWith([{ id: 'b', name: 'Bash', args: { command: 'ls' }, status: 'success' }]);
    expect(selectLatestTodo([msg])).toBeNull();
  });
});
