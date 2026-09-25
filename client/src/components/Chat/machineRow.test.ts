/**
 * @covers TOPIC-PREVIEW-01
 */
import { describe, it, expect } from 'bun:test';
import { isMachineRow, machineStopOf } from './machineRow';

describe('isMachineRow', () => {
  it('the goal loop and the board envelope are machinery', () => {
    expect(isMachineRow([{ kind: 'goal-nudge', attempt: 1 }])).toBe(true);
    expect(isMachineRow([{ kind: 'goal-stop', reason: 'stalled' }])).toBe(true);
    expect(isMachineRow([{ kind: 'dispatched-envelope' }])).toBe(true);
    // The line under a turn the machine stopped: without it the live frame's
    // sentence became the chat's preview in the sidebar.
    expect(isMachineRow([{ kind: 'machine-stop', cause: 'superseded', text: 'Fermato' }])).toBe(true);
  });

  it('a person or a model answer is not', () => {
    expect(isMachineRow([{ kind: 'text', text: 'ciao' }])).toBe(false);
    expect(isMachineRow([])).toBe(false);
    expect(isMachineRow(undefined)).toBe(false);
  });
});

describe('machineStopOf', () => {
  it('reads the cause of the stop line, and nothing else', () => {
    expect(machineStopOf([{ kind: 'machine-stop', cause: 'wall-clock', text: 'Fermato' }])).toBe('wall-clock');
    expect(machineStopOf([{ kind: 'goal-stop', reason: 'capped' }])).toBeNull();
    expect(machineStopOf([{ kind: 'error', text: 'Nessuna risposta', cause: 'stall' }])).toBeNull();
    expect(machineStopOf(undefined)).toBeNull();
  });
});
