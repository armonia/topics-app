/** @covers KANBAN-73 */
import { describe, expect, test } from 'bun:test';
import type { ChatMessage, ContentBlock, ToolCall } from '../../types';
import { taskSessionSegments } from './taskSessionPresentation';
import { mergeTaskTimeline } from './taskTimeline';
import type { TaskComment } from '../../../../shared/board';
import { extractMediaPaths } from '../messageMedia';

const call: ToolCall = { id: 'read', name: 'Read', args: {}, status: 'success' };
const blocks: ContentBlock[] = [
  { kind: 'text', text: 'Checking.' },
  { kind: 'thinking', text: 'Reasoning.' },
  { kind: 'tool', toolCall: call },
  { kind: 'text', text: 'Ready.' },
];
const message: ChatMessage = { id: 'turn', role: 'assistant', content: 'Checking.Ready.', timestamp: '2026-09-08T12:00:00Z', blocks };

describe('task session presentation', () => {
  test('a represented, settled turn folds once without changing its transcript', () => {
    expect(taskSessionSegments(message, true)).toEqual([{ message, folded: true, sessionDetail: true }]);
    expect(taskSessionSegments(message, true)[0].message).toBe(message);
  });

  test('unrepresented prose stays visible with each work stretch in its chronological place', () => {
    const parts = taskSessionSegments(message);
    expect(parts.map((part) => part.folded)).toEqual([false, true, false]);
    expect(parts.flatMap((part) => part.message.blocks ?? [])).toEqual(blocks);
    expect(parts.map((part) => part.message.content)).toEqual(['Checking.', '', 'Ready.']);
    expect(parts[1].message.toolCalls).toEqual([call]);
    expect(parts[1].message.thinking).toBe('Reasoning.');
  });

  test.each(['waiting_for_input', 'awaiting_permission', 'running', 'pending'] as const)('never folds human requests or active work: %s', (status) => {
    const active: ChatMessage = { ...message, blocks: [{ kind: 'tool', toolCall: { ...call, status } }] };
    expect(taskSessionSegments(active, true)).toEqual([{ message: active, folded: false }]);
  });

  test('streaming, errors and human text remain intact, including attachments', () => {
    for (const salient of [
      { ...message, partial: true, media: ['result.png'] },
      { ...message, content: 'MEDIA:/tmp/result.png', blocks: [{ kind: 'error' as const, text: 'The turn failed.' }] },
      { ...message, role: 'user' as const },
    ]) expect(taskSessionSegments(salient, true)).toEqual([{ message: salient, folded: false }]);
  });

  test('legacy content is retained when reconstructing blocks for mixed tool output', () => {
    const legacy: ChatMessage = { ...message, blocks: undefined, thinking: 'Reasoning.', toolCalls: [call] };
    const parts = taskSessionSegments(legacy);
    expect(parts.map((part) => part.folded)).toEqual([true, false]);
    expect(parts[1].message.content).toBe(message.content);
  });

  test('the real task shape folds 37 tools while its late content-only image stays visible once', () => {
    const calls = Array.from({ length: 37 }, (_, i) => ({ ...call, id: `work-${i}` }));
    const transcript: ContentBlock[] = [{ kind: 'text', text: 'Completed the work.' },
      ...calls.map((toolCall) => ({ kind: 'tool' as const, toolCall })),
    ];
    const attached: ChatMessage = { ...message, content: 'Completed the work.\nMEDIA:/tmp/result.svg', toolCalls: calls, blocks: transcript };
    const parts = taskSessionSegments(attached, true);
    expect(parts.map((part) => part.folded)).toEqual([true, false]);
    expect(parts[0].sessionDetail).toBe(true);
    expect(parts[0].message.blocks).toEqual(transcript);
    expect(parts[0].message.toolCalls).toHaveLength(37);
    expect(extractMediaPaths(parts[0].message.content).mediaPaths).toEqual([]);
    expect(parts[0].message.media ?? []).toEqual([]);
    expect(parts[1].message.media).toEqual(['/tmp/result.svg']);
    expect(parts[1].message.blocks ?? []).toEqual([]);
    expect(parts[1].message.toolCalls ?? []).toEqual([]);
    expect(attached.content).toContain('MEDIA:/tmp/result.svg');
  });

  test('append-only and explicit attachments are deduplicated and voice identity survives', () => {
    const attached: ChatMessage = { ...message,
      content: `${message.content}\n[Voice message: /tmp/voice clip.wav]\nMEDIA:/tmp/result.svg`,
      media: ['/tmp/result.svg', '/tmp/voice clip.wav', '/tmp/report file.pdf'],
    };
    const parts = taskSessionSegments(attached, true);
    expect(parts.map((part) => part.folded)).toEqual([true, false]);
    expect(parts[1].message.media).toEqual(['/tmp/result.svg', '/tmp/voice clip.wav', '/tmp/report file.pdf']);
    expect([...extractMediaPaths(parts[1].message.content).voicePaths]).toEqual(['/tmp/voice clip.wav']);
    expect(extractMediaPaths(parts[0].message.content).mediaPaths).toEqual([]);
    expect(parts[0].message.media ?? []).toEqual([]);
  });

  test.each([false, true])('a block with inline media stays in chronological place, without an appended duplicate (represented: %s)', (represented) => {
    const imageBlock: ContentBlock = { kind: 'text', text: 'Listen here: MEDIA:/tmp/voice.wav' };
    const transcript: ContentBlock[] = [blocks[0], blocks[2], imageBlock, blocks[2], blocks[3]];
    const attached: ChatMessage = { ...message, blocks: transcript,
      content: 'Checking.Listen here: [Voice message: /tmp/voice.wav] Ready.', media: ['/tmp/voice.wav'],
    };
    const parts = taskSessionSegments(attached, represented);
    expect(parts.map((part) => part.folded)).toEqual(represented ? [true, false, true] : [false, true, false, true, false]);
    expect(parts.flatMap((part) => part.message.blocks ?? [])).toEqual(transcript);
    const imagePart = parts.find((part) => part.message.blocks?.includes(imageBlock))!;
    expect(imagePart.folded).toBe(false);
    expect([...extractMediaPaths(imagePart.message.content).voicePaths]).toEqual(['/tmp/voice.wav']);
    expect(parts.flatMap((part) => part.message.media ?? [])).toEqual([]);
  });

  test('unrepresented and legacy prose stays visible before append-only media', () => {
    for (const transcript of [blocks, undefined]) {
      const attached: ChatMessage = { ...message, blocks: transcript, toolCalls: [call],
        content: `${message.content}\n[Attached file: /tmp/report.pdf]`,
      };
      const parts = taskSessionSegments(attached);
      expect(parts.filter((part) => !part.folded).map((part) => extractMediaPaths(part.message.content).cleanText).join('')).toBe(message.content);
      expect(parts[parts.length - 1].message.media).toEqual(['/tmp/report.pdf']);
      expect(parts.filter((part) => part.folded).flatMap((part) => extractMediaPaths(part.message.content).mediaPaths)).toEqual([]);
    }
  });

  test('an attachment-only reply has one visible segment and no empty work detail', () => {
    const attached: ChatMessage = { ...message, content: 'MEDIA:/tmp/result.svg', blocks: undefined };
    const parts = taskSessionSegments(attached, true);
    expect(parts).toHaveLength(1);
    expect(parts[0].folded).toBe(false);
    expect(parts[0].message.media).toEqual(['/tmp/result.svg']);
    expect(parts[0].message.toolCalls ?? []).toEqual([]);
  });

  test('a reply arriving for the same message invalidates only its derived presentation', () => {
    const options = { status: 'review' };
    const reply: TaskComment = { id: 'reply', taskId: 'task', messageId: message.id, author: 'agent', kind: 'comment', content: 'Ready.', createdAt: message.timestamp, mentions: [], media: [] };
    const initial = mergeTaskTimeline([], [message], options);
    const updated = mergeTaskTimeline([reply], [message], options, initial);
    const session = updated.find((item) => item.source === 'session')!;
    expect(session).not.toBe(initial[0]);
    expect(session.source === 'session' && session.hasThreadReply).toBe(true);
    const next = mergeTaskTimeline([reply], [message], options, updated);
    expect(next.find((item) => item.source === 'session')).toBe(session);
  });
});
