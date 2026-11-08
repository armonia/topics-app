/**
 * The last lines of a command still running, for its open row (CHAT-TOOL-08).
 *
 * A long `bash` sends its output while it runs as `stream:tool_update`, which
 * replaces the row's `result` with the whole current tail. The row shows only
 * the end of it, at a fixed height, so the chat does not jump on every frame;
 * the complete output comes back, as before, once the command closes.
 */
import type { ToolCall } from '../../types';
import { isActiveTool } from './toolGrouping';

/** How many lines of a running command the open row shows. */
export const RUNNING_TAIL_LINES = 8;

export interface ShellTail {
  lines: string[];
  /**
   * There was output above the lines shown. No count on purpose: the native
   * runtime already sends only the last 16 KB, so any number would be false.
   */
  hiddenAbove: boolean;
}

/**
 * The last `maxLines` lines of a partial output.
 *
 * A line redrawn with `\r` (a progress bar, `curl`) counts as its last redraw,
 * not as a wall of text: of its `\r` segments the last non-empty one is kept,
 * which is what a terminal leaves on screen, and it keeps a CRLF line from
 * turning blank. The empty line after a final newline is not a line.
 */
export function liveShellTail(output: string, maxLines = RUNNING_TAIL_LINES): ShellTail {
  const lines = output.split('\n').map((line) => line.split('\r').filter(Boolean).at(-1) ?? '');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return { lines: lines.slice(-maxLines), hiddenAbove: lines.length > maxLines };
}

/**
 * The partial output a shell row still running should show as a tail, or
 * `undefined` when the row shows its output as it always has.
 *
 * The test is on the TYPED detail the server sent, not on the resolved one. In
 * the window you sent from the row comes off the SSE with no detail at all, and
 * the derived one takes `result`, the partial, as its `output`: asking the
 * resolved detail would answer "it already has an output" and the tail would
 * never show in the window most likely to be watching.
 */
export function runningShellOutput(tc: ToolCall): string | undefined {
  if (!isActiveTool(tc) || typeof tc.result !== 'string' || tc.result === '') return undefined;
  if (tc.detail?.type === 'shell' && tc.detail.output) return undefined;
  return tc.result;
}
