/**
 * THE ROW OF A COMMAND STILL RUNNING SHOWS ITS LAST EIGHT LINES.
 *
 * Tool UX review of 23/09, finding 7: a `bash` at p90 lasts 65-115 s and its
 * row showed a spinner and the command, nothing else. The output often DID
 * arrive (codex, acp and openclaw send it as `stream:tool_update`) and was
 * written into `result`, but the row had a typed `shell` detail with no
 * `output`, and `resolveToolDetail` answers with that one first: the card got
 * `output = undefined` for as long as the command ran.
 *
 * The cut is pure so it can be measured here: eight lines, a `\r` progress bar
 * counted as its last redraw, and whether anything was left above. Which rows
 * get a tail at all is decided here too, because in the window you sent from
 * the row has no typed detail and the derived one already carries the partial
 * as its output.
 * @covers CHAT-TOOL-08
 */
import { describe, expect, test } from 'bun:test';
import { liveShellTail, runningShellOutput } from './runningShellTail';
import type { ToolCall } from '../../types';

const twentyLines = Array.from({ length: 20 }, (_, i) => `r${i + 1}`).join('\n');

function bashRow(over: Partial<ToolCall>): ToolCall {
  return {
    id: 'tu_bash',
    name: 'Bash',
    args: { command: 'bun test' },
    status: 'running',
    detail: { type: 'shell', command: 'bun test' },
    ...over,
  };
}

describe('the tail of a running shell row', () => {
  test('twenty lines, eight are shown, and it says there is more above', () => {
    const tail = liveShellTail(runningShellOutput(bashRow({ result: twentyLines }))!);
    expect(tail.lines).toEqual(['r13', 'r14', 'r15', 'r16', 'r17', 'r18', 'r19', 'r20']);
    expect(tail.hiddenAbove).toBe(true);
  });

  test('a progress bar is one line: its last redraw', () => {
    expect(liveShellTail('fetching\n 10%\r 50%\r100%\ndone').lines).toEqual(['fetching', '100%', 'done']);
  });

  test('a short output hides nothing, and the final newline is not a line', () => {
    expect(liveShellTail('a\nb\n')).toEqual({ lines: ['a', 'b'], hiddenAbove: false });
  });

  test('a line ended by CRLF keeps its text instead of turning blank', () => {
    expect(liveShellTail('a\r\nb\r\n').lines).toEqual(['a', 'b']);
  });
});

describe('which rows get a tail', () => {
  test('the window you sent from: no typed detail, the partial is still a tail', () => {
    expect(runningShellOutput(bashRow({ detail: undefined, result: 'r1' }))).toBe('r1');
  });

  test('a closed row, a typed final output or an empty partial get none', () => {
    expect(runningShellOutput(bashRow({ status: 'success', result: twentyLines }))).toBeUndefined();
    expect(runningShellOutput(bashRow({ detail: { type: 'shell', command: 'bun test', output: 'final' }, result: 'r1' }))).toBeUndefined();
    expect(runningShellOutput(bashRow({ result: '' }))).toBeUndefined();
  });
});
