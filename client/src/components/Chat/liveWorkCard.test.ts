/**
 * Which card of the transcript started a command of the strip: by the process
 * its answer names, and, on a row the history shipped without its answer, by
 * what it ran and when.
 *
 * @covers SUBSTRIP-02
 */
import { describe, expect, test } from 'bun:test';
import { findLaunchCard, launchedProcessId } from './liveWorkCard';
import type { ChatMessage, ToolCall } from '../../types';
import type { LiveCommandRow } from '../../../../shared/live-work';

const PID = 'd99716b5-d372-4e82-be4b-5f5a565ff315';
const OTHER = '0f2bd078-8678-4795-b09a-5c0a846ba489';
const START = '2026-10-07T22:59:49.675Z';
const AT = Date.parse(START);
const MUSE = 'cd /pop && freeagent -C /pop "$(cat .scratch/fa.txt)" > .scratch/fa.log 2>&1';

const row = (over: Partial<LiveCommandRow> = {}): LiveCommandRow => ({
  kind: 'command', id: PID, name: 'Muse wallrun', command: MUSE, preview: '', startedAt: START, listen: [], wakes: true, ...over,
});

const answer = (pid: string) => `started · processId=${pid} · pid=4242 · this topic gets a message with the outcome when it ends, so you can end your turn`;

function call(id: string, over: Partial<ToolCall> = {}): ToolCall {
  return { id, name: 'run_command', args: { command: MUSE, description: 'Muse wallrun' }, status: 'success', ...over };
}

function msg(id: string, calls: ToolCall[], asBlocks = false): ChatMessage {
  return {
    id, role: 'assistant', content: '', timestamp: START,
    ...(asBlocks ? { blocks: calls.map((toolCall) => ({ kind: 'tool' as const, toolCall })) } : { toolCalls: calls }),
  };
}

describe('launchedProcessId', () => {
  test('reads the process a run_command or run_script answer started', () => {
    expect(launchedProcessId(answer(PID))).toBe(PID);
    expect(launchedProcessId(`started · processId=${PID} · pid=1 — read output with read_process_output(process_id="${PID}")`)).toBe(PID);
  });

  test('an answer that started nothing names nothing', () => {
    expect(launchedProcessId(undefined)).toBeNull();
    expect(launchedProcessId('')).toBeNull();
    expect(launchedProcessId('run_command: server did not return a processId')).toBeNull();
  });
});

describe('findLaunchCard', () => {
  test('the call whose answer names the process, among calls that started others', () => {
    const messages = [
      msg('m1', [call('t1', { result: answer(PID) })]),
      msg('m2', [call('t2', { result: answer(OTHER) })]),
    ];
    expect(findLaunchCard(messages, row())).toEqual({ messageId: 'm1', toolCallId: 't1' });
  });

  test('the answer in the detail only, as a live shell card or an MCP card holds it', () => {
    const shell = call('t1', { detail: { type: 'shell', command: MUSE, output: answer(PID) } });
    const mcp = call('t2', { name: 'mcp__topics__run_command', detail: { type: 'mcp', server: 'topics', tool: 'run_command', args: { command: 'x' }, result: answer(OTHER) } });
    expect(findLaunchCard([msg('m1', [shell], true)], row())).toEqual({ messageId: 'm1', toolCallId: 't1' });
    expect(findLaunchCard([msg('m2', [mcp])], row({ id: OTHER }))).toEqual({ messageId: 'm2', toolCallId: 't2' });
  });

  test('a call whose answer names another process is not this one, even running the same line', () => {
    expect(findLaunchCard([msg('m1', [call('t1', { result: answer(OTHER) })])], row())).toBeNull();
  });

  test('history row without its answer: the command it ran, trimmed as the server stores it', () => {
    const messages = [msg('m1', [call('t1', { args: { command: `  ${MUSE}\n` }, detail: { type: 'shell', command: MUSE, output: '' }, detailBytes: 120 })])];
    expect(findLaunchCard(messages, row())).toEqual({ messageId: 'm1', toolCallId: 't1' });
  });

  test('a command the history cut to its head matches by its start, only when the cut is declared', () => {
    const head = MUSE.slice(0, 30);
    const cut = call('t1', { args: { command: head }, argsBytes: MUSE.length - 30 });
    const notCut = call('t2', { args: { command: head } });
    expect(findLaunchCard([msg('m1', [cut])], row())).toEqual({ messageId: 'm1', toolCallId: 't1' });
    expect(findLaunchCard([msg('m2', [notCut])], row())).toBeNull();
  });

  test('the same line launched three times: the launch that started closest to the process', () => {
    const messages = [
      msg('m1', [call('t1', { startedAt: AT - 3_600_000 })]),
      msg('m2', [call('t2', { startedAt: AT - 50 })]),
      msg('m3', [call('t3', { startedAt: AT + 3_600_000 })]),
    ];
    expect(findLaunchCard(messages, row())).toEqual({ messageId: 'm2', toolCallId: 't2' });
  });

  test('without times, the newest launch of the line', () => {
    const messages = [msg('m1', [call('t1')]), msg('m2', [call('t2')])];
    expect(findLaunchCard(messages, row())).toEqual({ messageId: 'm2', toolCallId: 't2' });
  });

  test('a run_script by the script it named, bare or behind the MCP prefix', () => {
    const script = row({ name: 'dev', command: 'vite --port 5173' });
    expect(findLaunchCard([msg('m1', [call('t1', { name: 'run_script', args: { script: 'dev' } })])], script)).toEqual({ messageId: 'm1', toolCallId: 't1' });
    expect(findLaunchCard([msg('m1', [call('t1', { name: 'mcp__topics__run_script', args: { script: 'test' } })])], script)).toBeNull();
  });

  test('other tools running the same line are not the card: a Bash is not a run_command', () => {
    expect(findLaunchCard([msg('m1', [call('t1', { name: 'Bash' })])], row())).toBeNull();
  });

  test('nothing in this transcript: no card (another session, or history not loaded)', () => {
    expect(findLaunchCard([], row())).toBeNull();
    expect(findLaunchCard([msg('m1', [call('t1', { args: { command: 'npm test' } })])], row())).toBeNull();
  });
});
