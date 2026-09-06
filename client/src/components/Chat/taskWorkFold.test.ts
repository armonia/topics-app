/**
 * @covers CHAT-TOOL-06
 *
 * The partition a task chat is folded by: what a person reads to decide, and
 * what only proves the work. Pure, so the boundaries can be stated one by one
 * instead of inferred from a screenshot.
 */
import { describe, expect, test } from 'bun:test';
import type { ChatMessage, ToolCall } from '../../types';
import {
  baseName,
  isMachineWork,
  partitionTurn,
  summarizeWork,
  toolsOf,
} from './taskWorkFold';

let seq = 0;
function tc(partial: Partial<ToolCall> & { name: string }): ToolCall {
  return { id: `tc-${++seq}`, args: {}, status: 'success', ...partial };
}

function msg(partial: Partial<ChatMessage>): ChatMessage {
  return {
    id: `m-${++seq}`,
    role: 'assistant',
    content: '',
    timestamp: new Date(1_700_000_000_000).toISOString(),
    ...partial,
  } as ChatMessage;
}

describe('isMachineWork', () => {
  test('wordless actions are work', () => {
    expect(isMachineWork(msg({ toolCalls: [tc({ name: 'Read' })] }))).toBe(true);
  });

  test('reasoning without actions is work too', () => {
    expect(isMachineWork(msg({ thinking: 'let me look' }))).toBe(true);
  });

  test('prose is never work, however many actions travel with it', () => {
    expect(isMachineWork(msg({ content: 'Done, the build is green.', toolCalls: [tc({ name: 'Bash' })] }))).toBe(false);
  });

  test('a human message is never work', () => {
    expect(isMachineWork(msg({ role: 'user', content: 'go on' }))).toBe(false);
  });

  test('a question to the human is never folded', () => {
    expect(isMachineWork(msg({ toolCalls: [tc({ name: 'AskUserQuestion', status: 'waiting_for_input' })] }))).toBe(false);
  });

  test('work still running is never folded: it is watched', () => {
    expect(isMachineWork(msg({ toolCalls: [tc({ name: 'Bash', status: 'running' })] }))).toBe(false);
    expect(isMachineWork(msg({ partial: true, toolCalls: [tc({ name: 'Bash' })] }))).toBe(false);
  });

  test('an attachment is a delivery, not machinery', () => {
    expect(isMachineWork(msg({ media: ['/tmp/shot.png'], toolCalls: [tc({ name: 'Read' })] }))).toBe(false);
  });

  test('an empty assistant message folds nothing (there is no work to hide)', () => {
    expect(isMachineWork(msg({}))).toBe(false);
  });

  test('a failed run is still work: the summary carries the verdict', () => {
    expect(isMachineWork(msg({ toolCalls: [tc({ name: 'Bash', status: 'error' })] }))).toBe(true);
  });
});

describe('partitionTurn', () => {
  test('a turn becomes one salient head, one work stretch, one salient answer', () => {
    const segments = partitionTurn([
      msg({ role: 'user', content: 'fix the module' }),
      msg({ toolCalls: [tc({ name: 'Read' })] }),
      msg({ toolCalls: [tc({ name: 'Edit' })] }),
      msg({ toolCalls: [tc({ name: 'Bash' })] }),
      msg({ content: 'Fixed.' }),
    ]);
    expect(segments.map((s) => s.kind)).toEqual(['salient', 'work', 'salient']);
    const work = segments[1];
    expect(work.kind === 'work' && work.messages.length).toBe(3);
  });

  test('prose in the middle splits the work instead of moving: order is never rewritten', () => {
    const segments = partitionTurn([
      msg({ toolCalls: [tc({ name: 'Read' })] }),
      msg({ content: 'I found the cause.' }),
      msg({ toolCalls: [tc({ name: 'Edit' })] }),
    ]);
    expect(segments.map((s) => s.kind)).toEqual(['work', 'salient', 'work']);
  });

  test('a question interrupts the fold and stays in plain sight', () => {
    const segments = partitionTurn([
      msg({ toolCalls: [tc({ name: 'Read' })] }),
      msg({ toolCalls: [tc({ name: 'AskUserQuestion', status: 'waiting_for_input' })] }),
      msg({ toolCalls: [tc({ name: 'Read' })] }),
    ]);
    expect(segments.map((s) => s.kind)).toEqual(['work', 'salient', 'work']);
  });

  test('nothing is lost: every message comes back exactly once, in order', () => {
    const input = [
      msg({ role: 'user', content: 'go' }),
      msg({ toolCalls: [tc({ name: 'Read' })] }),
      msg({ content: 'done' }),
    ];
    const out = partitionTurn(input).flatMap((s) => (s.kind === 'work' ? s.messages : [s.message]));
    expect(out.map((m) => m.id)).toEqual(input.map((m) => m.id));
  });

  test('an empty transcript has no segments', () => {
    expect(partitionTurn([])).toEqual([]);
  });
});

describe('summarizeWork', () => {
  test('counts actions, failures, written files and sub-agents', () => {
    const summary = summarizeWork([
      msg({ toolCalls: [tc({ name: 'Read', args: { file_path: '/repo/src/a.ts' } })] }),
      msg({
        toolCalls: [
          tc({ name: 'Edit', args: { file_path: '/repo/src/a.ts' } }),
          tc({ name: 'Write', args: { file_path: '/repo/src/b.ts' } }),
          tc({ name: 'Edit', args: { file_path: '/repo/src/a.ts' } }),
        ],
      }),
      msg({ toolCalls: [tc({ name: 'Bash', args: { command: 'bun test' }, status: 'error' })] }),
      msg({ toolCalls: [tc({ name: 'Task', args: { subagent_type: 'Explore' } })] }),
    ]);
    expect(summary.total).toBe(6);
    expect(summary.errors).toBe(1);
    // A file written twice is one file, and a file only READ is not touched.
    expect(summary.files).toEqual(['/repo/src/a.ts', '/repo/src/b.ts']);
    expect(summary.subAgents).toBe(1);
    expect(summary.counts[0]?.count).toBeGreaterThan(0);
  });

  test('duration spans the whole stretch, first start to last end', () => {
    const summary = summarizeWork([
      msg({ toolCalls: [tc({ name: 'Read', startedAt: 1000, endedAt: 1200 })] }),
      msg({ toolCalls: [tc({ name: 'Bash', startedAt: 1300, endedAt: 4000 })] }),
    ]);
    expect(summary.durationMs).toBe(3000);
  });

  test('no actions, no numbers', () => {
    const summary = summarizeWork([msg({ thinking: 'hmm' })]);
    expect(summary.total).toBe(0);
    expect(summary.files).toEqual([]);
    expect(summary.durationMs).toBeUndefined();
  });
});

describe('toolsOf / baseName', () => {
  test('actions are read from the block timeline when there is one', () => {
    const call = tc({ name: 'Read' });
    expect(toolsOf(msg({ blocks: [{ kind: 'tool', toolCall: call }] })).map((t) => t.id)).toEqual([call.id]);
  });

  test('and from the legacy bucket when there is not', () => {
    const call = tc({ name: 'Read' });
    expect(toolsOf(msg({ toolCalls: [call] })).map((t) => t.id)).toEqual([call.id]);
  });

  test('basename of a path, and of something that is not one', () => {
    expect(baseName('/repo/src/a.ts')).toBe('a.ts');
    expect(baseName('a.ts')).toBe('a.ts');
  });
});
