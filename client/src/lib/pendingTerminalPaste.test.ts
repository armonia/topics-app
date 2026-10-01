/**
 * «OPEN IN TERMINAL» TYPES THE COMMAND, AND NEVER RUNS IT.
 *
 * The text waits for the new shell's first screen and is taken once. Pasted
 * with bracketed paste on, several lines go in as one paste and none runs;
 * with it off, a newline would be an Enter, so several lines are not pasted at
 * all: they go to the clipboard instead. A control byte never reaches the
 * shell: an escape could close the bracketed paste early and run what follows,
 * and a bare carriage return is an Enter.
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

  test('control bytes are dropped before the shell sees them; a bare carriage return is a line break', () => {
    // ESC[201~ inside the text would end the bracketed paste and run the next line.
    setPendingTerminalPaste('s-3', 'echo safe\u001b[201~\ntouch /tmp/pwned');
    expect(takePendingTerminalPaste('s-3')).toBe('echo safe[201~\ntouch /tmp/pwned');
    setPendingTerminalPaste('s-4', 'echo a\rtouch x');
    const bare = takePendingTerminalPaste('s-4')!;
    expect(bare).toBe('echo a\ntouch x');
    expect(pasteDecision(bare, false)).toBe('clipboard');
    setPendingTerminalPaste('s-5', 'printf "a\tb"\r\n\u0007\u007fls\u0003');
    expect(takePendingTerminalPaste('s-5')).toBe('printf "a\tb"\nls');
  });

  test('a carriage return counts as a line break even if one gets past', () => {
    expect(pasteDecision('echo a\rtouch x', false)).toBe('clipboard');
  });
});
