/** @covers KANBAN-73 */
import { expect, test } from 'bun:test';
import { formatStatusEvent, type TaskComment } from '../../../../shared/board';
import type { ChatMessage } from '../../types';
import { mergeTaskTimeline } from './taskTimeline';
import { taskSessionRuns } from './taskSessionRuns';
import { taskSessionSegments } from './taskSessionPresentation';

const at = (minute: number) => `2026-09-08T12:${String(minute).padStart(2, '0')}:00Z`;
const assistant = (id: string, minute: number, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id, role: 'assistant', content: id, timestamp: at(minute), ...extra,
});
const status = (minute: number): TaskComment => ({
  id: `status-${minute}`, taskId: 'task', author: 'user', kind: 'status',
  content: formatStatusEvent('review', 'in_progress'), createdAt: at(minute), mentions: [], media: [],
});

test('a missing transition folds only the proven current run, preserving historical replies', () => {
  const timeline = mergeTaskTimeline([], [assistant('old answer', 1), assistant('current progress', 20)], { status: 'in_progress' });
  const unknown = taskSessionRuns(timeline, true);
  expect([...unknown.runs.values()].flat().map((item) => item.foldProgress)).toEqual([false, false]);
  const bounded = taskSessionRuns(timeline, true, at(10));
  expect([...bounded.runs.values()].flat().map((item) => item.foldProgress)).toEqual([false, true]);
});

test('the latest reopen drives the current run and timer instead of the lifetime start', () => {
  const timeline = mergeTaskTimeline([status(2), status(15)], [assistant('old answer', 3), assistant('progress', 16)], { status: 'in_progress' });
  const result = taskSessionRuns(timeline, true, at(0));
  expect(result.since).toBe(at(15));
  expect([...result.runs.values()].flat().map((item) => item.foldProgress)).toEqual([false, true]);
});

test('a completed multi-message turn keeps progress folded and the final response visible', () => {
  const timeline = mergeTaskTimeline([], [
    assistant('Checking sources', 1),
    assistant('Inspected sources', 2, { blocks: [{ kind: 'tool', toolCall: { id: 'read', name: 'Read', args: {}, status: 'success' } }] }),
    assistant('The source is already available.', 3),
  ], { status: 'review' });
  const result = taskSessionRuns(timeline, false);
  expect(result.runs.size).toBe(1);
  const parts = [...result.runs.values()].flat().flatMap((item) => taskSessionSegments(item.msg, item.hasThreadReply, item.foldProgress));
  expect(parts.filter((part) => !part.folded).map((part) => part.message.content)).toEqual(['The source is already available.']);
  expect(parts.filter((part) => part.folded).map((part) => part.message.content)).toContain('Checking sources');
});

test('a human reply separates turns and work cannot swallow the prior answer', () => {
  const timeline = mergeTaskTimeline([], [assistant('Prior final answer', 1),
    { id: 'human', role: 'user', content: 'Check the chart', timestamp: at(2) },
    assistant('Working', 3, { toolCalls: [{ id: 'read', name: 'Read', args: {}, status: 'running' }] }),
  ], { status: 'in_progress' });
  const result = taskSessionRuns(timeline, true, at(2));
  expect(result.runs.size).toBe(2);
  expect([...result.runs.values()][0][0].foldProgress).toBe(false);
});

test('a waiting question preserves the unmirrored answer that explains its context', () => {
  const timeline = mergeTaskTimeline([], [assistant('The result is ready.', 1, { blocks: [
    { kind: 'tool', toolCall: { id: 'read', name: 'Read', args: {}, status: 'success' } },
    { kind: 'text', text: 'The result is ready.' },
  ] }), assistant('', 2, { id: 'waiting', blocks: [
    { kind: 'tool', toolCall: { id: 'ask', name: 'AskUserQuestion', args: {}, status: 'waiting_for_input' } },
  ] })], { status: 'review' });
  const result = taskSessionRuns(timeline, false);
  const parts = [...result.runs.values()].flat().flatMap((item) => taskSessionSegments(item.msg, item.hasThreadReply, item.foldProgress));
  expect(parts.filter((part) => !part.folded).map((part) => part.message.content)).toContain('The result is ready.');
});
