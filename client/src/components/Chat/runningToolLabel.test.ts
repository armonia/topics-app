import { describe, expect, test } from 'bun:test';
import { runningToolLabel } from './runningToolLabel';

describe('runningToolLabel', () => {
  test('names the last tool still running, with its command', () => {
    const msg = {
      blocks: [
        { kind: 'tool', toolCall: { id: '1', name: 'Read', args: {}, status: 'success' } },
        { kind: 'tool', toolCall: { id: '2', name: 'Bash', args: { command: 'bun   test' }, status: 'running' } },
      ],
    } as never;
    expect(runningToolLabel(msg)).toBe('Bash bun test');
  });
  test('null when nothing is running', () => {
    expect(runningToolLabel({ toolCalls: [{ id: '1', name: 'Read', args: {}, status: 'success' }] } as never)).toBeNull();
  });
});
