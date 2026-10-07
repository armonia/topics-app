import { describe, it, expect } from 'bun:test';
import { stripAnsi } from './stripAnsi';

describe('stripAnsi', () => {
  it('turns freeagent red error line into plain text', () => {
    expect(stripAnsi('\x1b[91m\x1b[1mError: \x1b[0mThe user rejected permission to use this specific tool call.'))
      .toBe('Error: The user rejected permission to use this specific tool call.');
  });

  it('drops a code whose ESC byte was already lost', () => {
    expect(stripAnsi('[91m[1mError: [0mok')).toBe('Error: ok');
  });
});
