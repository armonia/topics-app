/**
 * @covers TOPIC-PREVIEW-01
 */
import { describe, it, expect } from 'bun:test';
import { isMachineRow } from './machineRow';

describe('isMachineRow', () => {
  it('the goal loop and the board envelope are machinery', () => {
    expect(isMachineRow([{ kind: 'goal-nudge', attempt: 1 }])).toBe(true);
    expect(isMachineRow([{ kind: 'goal-stop', reason: 'stalled' }])).toBe(true);
    expect(isMachineRow([{ kind: 'dispatched-envelope' }])).toBe(true);
  });

  it('a person or a model answer is not', () => {
    expect(isMachineRow([{ kind: 'text', text: 'ciao' }])).toBe(false);
    expect(isMachineRow([])).toBe(false);
    expect(isMachineRow(undefined)).toBe(false);
  });
});
