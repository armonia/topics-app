/**
 * «OPEN IN TERMINAL» TYPES THE COMMAND, AND NEVER RUNS IT.
 *
 * The text waits for the new shell's first screen and is taken once. Pasted
 * with bracketed paste on, several lines go in as one paste and none runs;
 * with it off, a newline would be an Enter, so several lines are not pasted at
 * all: they go to the clipboard instead.
 * @covers CHAT-RUN-05
 */
import { describe, expect, test } from 'bun:test';
import { pasteDecision, setPendingTerminalPaste, takePendingTerminalPaste } from './pendingTerminalPaste';

describe('pendingTerminalPaste', () => {
  test('taken once, by the session it was left for', () => {
    setPendingTerminalPaste('s-1', 'sudo wg-quick up edm');
    expect(takePendingTerminalPaste('s-2')).toBeUndefined();
    expect(takePendingTerminalPaste('s-1')).toBe('sudo wg-quick up edm');
    expect(takePendingTerminalPaste('s-1')).toBeUndefined();
  });

  test('one line is pasted either way; several only with bracketed paste on', () => {
    expect(pasteDecision('sudo wg-quick up edm', false)).toBe('paste');
    expect(pasteDecision('cd app\nbun test', true)).toBe('paste');
    expect(pasteDecision('cd app\nbun test', false)).toBe('clipboard');
  });
});
