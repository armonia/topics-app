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
    expect(taskSessionSegments(message, true)).toEqual([{ message: { ...message, id: 'turn:0' }, folded: true, sessionDetail: true }]);
  });

  test('the first folded segment keeps its identity when a live block gains media or a final answer', () => {
    const progress: ChatMessage = { ...message, partial: true, content: 'Checking.', blocks: [{ kind: 'text', text: 'Checking.' }] };
    const initial = taskSessionSegments(progress)[0].message.id;
    const withMedia = { ...progress, content: 'Checking.\nMEDIA:/tmp/chart.png', blocks: [{ kind: 'text' as const, text: 'Checking.\nMEDIA:/tmp/chart.png' }] };
    expect(taskSessionSegments(withMedia)[0].message.id).toBe(initial);
    expect(taskSessionSegments({ ...message, partial: false })[0].message.id).toBe(initial);
  });

  test('completed work folds its preceding prose and keeps the final unmirrored reply visible', () => {
    const parts = taskSessionSegments(message);
    expect(parts.map((part) => part.folded)).toEqual([true, false]);
    expect(parts.flatMap((part) => part.message.blocks ?? [])).toEqual(blocks);
    expect(parts.map((part) => part.message.content)).toEqual(['Checking.', 'Ready.']);
    expect(parts[0].sessionDetail).toBe(true);
    expect(parts[0].message.toolCalls).toEqual([call]);
    expect(parts[0].message.thinking).toBe('Reasoning.');
  });

  test.each(['waiting_for_input', 'awaiting_permission'] as const)('keeps the human request visible: %s', (status) => {
    const active: ChatMessage = { ...message, blocks: [{ kind: 'tool', toolCall: { ...call, status } }] };
    expect(taskSessionSegments(active, true)).toEqual([{ message: { ...active, id: `${active.id}:0` }, folded: false }]);
  });

  test.each(['running', 'pending'] as const)('normal live tool and progress text stay in one session detail: %s', (status) => {
    const live: ChatMessage = { ...message, partial: true, blocks: [blocks[0],
      { kind: 'tool', toolCall: { ...call, status } }, blocks[3],
    ] };
    expect(taskSessionSegments(live)).toEqual([{ message: { ...live, id: `${live.id}:0` }, folded: true, sessionDetail: true }]);
    expect(live.blocks?.[1].kind === 'tool' && live.blocks[1].toolCall.status).toBe(status);
  });

  test('activeRun folds completed message fragments and text-only progress until the turn finishes', () => {
    const textOnly: ChatMessage = { ...message, content: 'Checking the next source.', blocks: undefined };
    for (const progress of [message, textOnly, { ...textOnly, partial: true }]) {
      expect(taskSessionSegments(progress, false, true)).toEqual([{ message: { ...progress, id: `${progress.id}:0` }, folded: true, sessionDetail: true }]);
    }
    expect(taskSessionSegments(textOnly)).toEqual([{ message: { ...textOnly, id: `${textOnly.id}:0` }, folded: false }]);
    expect(taskSessionSegments({ ...textOnly, partial: true })[0].folded).toBe(true);
  });

  test('an active tool also keeps its trailing text folded when partial is absent', () => {
    const live: ChatMessage = { ...message, blocks: [
      { kind: 'tool', toolCall: { ...call, status: 'running' } }, blocks[3],
    ] };
    expect(taskSessionSegments(live)).toEqual([{ message: { ...live, id: `${live.id}:0` }, folded: true, sessionDetail: true }]);
  });

  test.each(['waiting_for_input', 'awaiting_permission', 'error'] as const)('a salient tool between ordinary tools does not expose the adjacent work: %s', (status) => {
    const salient: ToolCall = { ...call, id: 'needs-attention', status };
    const live: ChatMessage = { ...message, partial: true, blocks: [blocks[0], blocks[2],
      { kind: 'tool', toolCall: salient }, blocks[2], blocks[3],
    ] };
    const parts = taskSessionSegments(live, true, true);
    expect(parts.map((part) => part.folded)).toEqual([true, false, true]);
    expect(parts[1].message.toolCalls).toEqual([salient]);
    expect(parts[1].message.blocks).toEqual([{ kind: 'tool', toolCall: salient }]);
    expect(parts[1].message.content).toBe('');
    expect(parts.filter((part) => part.folded).every((part) => part.sessionDetail)).toBe(true);
    expect(parts.flatMap((part) => part.message.blocks ?? [])).toEqual(live.blocks!);
  });

  test('a structured text question stays visible during active work without showing adjacent tools', () => {
    const question: ContentBlock = { kind: 'text', text: '```question\nWhich source?\n- Orders\n- Contracts\n```' };
    const live: ChatMessage = { ...message, blocks: [blocks[2], question, blocks[2]] };
    const parts = taskSessionSegments(live, true, true);
    expect(parts.map((part) => part.folded)).toEqual([true, false, true]);
    expect(parts[1].message.blocks).toEqual([question]);
    expect(parts[1].message.toolCalls).toEqual([]);
  });

  test('turn errors remain visible once beside folded tools, including legacy content-only errors', () => {
    const errorBlock: ContentBlock = { kind: 'error', text: 'The turn failed.', cause: 'watchdog' };
    for (const failed of [
      { ...message, blocks: [blocks[0], blocks[2], errorBlock, blocks[2]] },
      { ...message, content: '⚠️ The turn failed.\n\nChecking.', blocks: [blocks[0], blocks[2]] },
      { ...message, content: '⚠️ The turn failed.\n\nChecking.', blocks: undefined, toolCalls: [call] },
    ]) {
      const parts = taskSessionSegments(failed, true);
      const visible = parts.filter((part) => !part.folded);
      expect(visible).toHaveLength(1);
      expect(visible[0].message.blocks?.map((block) => block.kind)).toEqual(['error']);
      expect(visible[0].message.blocks?.[0]).toMatchObject({ kind: 'error', text: 'The turn failed.' });
      expect(visible[0].message.toolCalls ?? []).toEqual([]);
      expect(parts.filter((part) => part.folded).every((part) => !part.message.content.includes('The turn failed.'))).toBe(true);
    }
  });

  test('human text remains intact, including attachments', () => {
    const human: ChatMessage = { ...message, role: 'user', partial: true, media: ['result.png'] };
    expect(taskSessionSegments(human, true, true)).toEqual([{ message: human, folded: false }]);
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

  test('partial progress stays folded while its late image and voice attachment remain visible once', () => {
    const live: ChatMessage = { ...message, partial: true,
      content: `${message.content}\nMEDIA:/tmp/result.svg\n[Voice message: /tmp/voice clip.wav]`,
      media: ['/tmp/result.svg', '/tmp/voice clip.wav'],
    };
    const parts = taskSessionSegments(live, false, true);
    expect(parts.map((part) => part.folded)).toEqual([true, false]);
    expect(parts[0].message.blocks).toEqual(blocks);
    expect(parts[0].message.media).toBeUndefined();
    expect(parts[1].message.media).toEqual(['/tmp/result.svg', '/tmp/voice clip.wav']);
    expect([...extractMediaPaths(parts[1].message.content).voicePaths]).toEqual(['/tmp/voice clip.wav']);
    expect(extractMediaPaths(parts[1].message.content).cleanText).toBe('');
    expect(parts[1].message.toolCalls).toBeUndefined();
  });

  test('inline attachments stay visible without exposing the text updates around them', () => {
    const live: ChatMessage = { ...message, partial: true, blocks: [blocks[2],
      { kind: 'text', text: 'Still checking. [Voice message: /tmp/voice clip.wav] Reading another source.' }, blocks[2],
    ], content: 'Still checking. [Voice message: /tmp/voice clip.wav] Reading another source.', media: ['/tmp/voice clip.wav'] };
    const parts = taskSessionSegments(live, false, true);
    expect(parts.map((part) => part.folded)).toEqual([true, false, true]);
    const shown = parts[1].message;
    expect(extractMediaPaths(shown.content).cleanText).toBe('');
    expect(extractMediaPaths(shown.content).mediaPaths).toEqual(['/tmp/voice clip.wav']);
    expect(shown.toolCalls).toEqual([]);
    expect(parts[0].message.content).toContain('Still checking.');
    expect(parts[2].message.content).toContain('Reading another source.');
    expect(parts.flatMap((part) => part.message.media ?? [])).toEqual([]);
  });

  test('a legacy failure and attachment both survive without duplicating voice or exposing work', () => {
    for (const transcript of [undefined, [blocks[2], { kind: 'text' as const, text: '⚠️ The turn failed.\n[Voice message: /tmp/voice.wav]' }]]) {
      const failed: ChatMessage = { ...message, blocks: transcript, toolCalls: [call],
        content: '⚠️ The turn failed.\n[Voice message: /tmp/voice.wav]', media: ['/tmp/voice.wav'],
      };
      const parts = taskSessionSegments(failed, true);
      const shown = parts.filter((part) => !part.folded);
      expect(shown.flatMap((part) => part.message.blocks?.filter((block) => block.kind === 'error') ?? [])).toEqual([{ kind: 'error', text: 'The turn failed.' }]);
      expect(shown.flatMap((part) => part.message.toolCalls ?? [])).toEqual([]);
      const inline = shown.flatMap((part) => part.message.blocks?.flatMap((block) => block.kind === 'text' ? extractMediaPaths(block.text).mediaPaths : []) ?? []);
      const appended = shown.flatMap((part) => part.message.media ?? []);
      expect([...inline, ...appended]).toEqual(['/tmp/voice.wav']);
      expect(shown.some((part) => extractMediaPaths(part.message.content).voicePaths.has('/tmp/voice.wav'))).toBe(true);
    }
  });

  test.each([false, true])('a block with inline media stays in chronological place, without an appended duplicate (represented: %s)', (represented) => {
    const imageBlock: ContentBlock = { kind: 'text', text: 'Listen here: MEDIA:/tmp/voice.wav' };
    const transcript: ContentBlock[] = [blocks[0], blocks[2], imageBlock, blocks[2], blocks[3]];
    const attached: ChatMessage = { ...message, blocks: transcript,
      content: 'Checking.Listen here: [Voice message: /tmp/voice.wav] Ready.', media: ['/tmp/voice.wav'],
    };
    const parts = taskSessionSegments(attached, represented);
    expect(parts.map((part) => part.folded)).toEqual(represented ? [true, false, true] : [true, false, true, false]);
    expect(parts.flatMap((part) => part.message.toolCalls ?? [])).toEqual([call, call]);
    const imagePart = parts.find((part) => extractMediaPaths(part.message.content).mediaPaths.includes('/tmp/voice.wav'))!;
    expect(imagePart.folded).toBe(false);
    expect([...extractMediaPaths(imagePart.message.content).voicePaths]).toEqual(['/tmp/voice.wav']);
    expect(parts.flatMap((part) => part.message.media ?? [])).toEqual([]);
  });

  test('only the final unmirrored reply and legacy final content stay visible before append-only media', () => {
    for (const transcript of [blocks, undefined]) {
      const attached: ChatMessage = { ...message, blocks: transcript, toolCalls: [call],
        content: `${message.content}\n[Attached file: /tmp/report.pdf]`,
      };
      const parts = taskSessionSegments(attached);
      expect(parts.filter((part) => !part.folded).map((part) => extractMediaPaths(part.message.content).cleanText).join('')).toBe(transcript ? 'Ready.' : message.content);
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

test.each(['waiting_for_input', 'awaiting_permission', 'error'] as const)('a salient tool preserves its preceding answer in the same completed message: %s', (status) => {
  const msg: ChatMessage = { ...message, blocks: [blocks[2], blocks[3], { kind: 'tool', toolCall: { ...call, id: 'attention', status } }] };
  const parts = taskSessionSegments(msg);
  expect(parts.filter((part) => !part.folded).flatMap((part) => part.message.blocks ?? [])).toEqual([blocks[3], msg.blocks![2]]);
});
