/**
 * What kind of work a row stands for: a sub-agent is not a background job.
 *
 * @covers CHAT-TOOL-14
 */
import { describe, expect, test } from 'bun:test';
import { deriveToolDetail } from '../../../../shared/tool-detail';
import { iconForCall, iconForDetail } from './toolIcons';
import { workKindOf } from './workKind';

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
