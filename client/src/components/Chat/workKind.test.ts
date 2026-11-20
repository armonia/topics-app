/**
 * What kind of work a row stands for: a sub-agent is not a background job.
 *
 * @covers CHAT-TOOL-14
 */
import { describe, expect, test } from 'bun:test';
import { deriveToolDetail } from '../../../../shared/tool-detail';
import { iconForCall, iconForDetail } from './toolIcons';
import type { ToolCall } from '../../types';
import { isEmptySubAgent, workKindOf } from './workKind';

const kind = (name: string, args: Record<string, unknown> = {}) => workKindOf(name, deriveToolDetail(name, args));

describe('workKindOf: a sub-agent is not a background job', () => {
  test('Task, Agent and spawn_agent are sub-agents', () => {
    expect(kind('Task', { description: 'x' })).toBe('subagent');
    expect(kind('Agent', { description: 'x' })).toBe('subagent');
    expect(kind('spawn_agent', { prompt: 'x' })).toBe('subagent');
    expect(kind('mcp__topics__spawn_agent', { prompt: 'x' })).toBe('subagent');
  });

  test('run_command, run_script and a background Bash are background work', () => {
    expect(kind('run_command', { command: 'bun run dev' })).toBe('background');
    expect(kind('mcp__topics__run_script', { script: 'dev' })).toBe('background');
    expect(kind('Bash', { command: 'sleep 9', run_in_background: true })).toBe('background');
  });

  test('a foreground Bash, a read and a board card are neither', () => {
    expect(kind('Bash', { command: 'ls' })).toBeUndefined();
    expect(kind('Read', { file_path: '/x' })).toBeUndefined();
  });

  test('the two kinds have two different icons', () => {
    const sub = iconForCall('Task', deriveToolDetail('Task', { description: 'x' }));
    const bg = iconForCall('run_command', deriveToolDetail('run_command', { command: 'x' }));
    expect(sub).not.toBe(bg);
    // A plain shell keeps the terminal of its detail.
    const sh = deriveToolDetail('Bash', { command: 'ls' });
    expect(iconForCall('Bash', sh)).toBe(iconForDetail(sh));
  });
});

describe('isEmptySubAgent: a settled sub-agent with nothing to say has no row', () => {
  const call = (over: Partial<ToolCall>): ToolCall => ({ id: 'x', name: 'Task', args: {}, status: 'success', ...over } as ToolCall);
  const empty = (c: ToolCall) => isEmptySubAgent(c, deriveToolDetail(c.name, c.args, c.result, { failed: c.status === 'error' }));

  test('finished with no name, description, type, activity or answer', () => {
    expect(empty(call({}))).toBe(true);
    expect(empty(call({ name: 'spawn_agent' }))).toBe(true);
  });

  test('anything to read keeps the row', () => {
    expect(empty(call({ args: { description: 'cerca' } }))).toBe(false);
    expect(empty(call({ args: { subagent_type: 'Explore' } }))).toBe(false);
    expect(empty(call({ result: 'ok' }))).toBe(false);
    expect(empty(call({ error: 'boom' }))).toBe(false);
  });

  test('a call still running, failed or not a sub-agent is never hidden', () => {
    expect(empty(call({ status: 'running' }))).toBe(false);
    expect(empty(call({ status: 'error' }))).toBe(false);
    expect(empty(call({ name: 'Read', args: { file_path: '/x' } }))).toBe(false);
  });
});
