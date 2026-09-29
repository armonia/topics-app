/**
 * The precedence of the tab slot, without a tab bar around it.
 *
 * @covers TABSLOT-02
 * @covers CHROME-12
 */
import { describe, test, expect } from 'bun:test';
import { tabSlotCommand, tabSlotSignal } from './tabSlot';

describe('tabSlotSignal', () => {
  test('freeze wins over everything, because a paused command is not working', () => {
    expect(tabSlotSignal({ frozen: true, working: true, attention: 4 })).toEqual({ kind: 'freeze' });
  });

  test('working carries the attention count, so the ring turns around the number', () => {
    expect(tabSlotSignal({ frozen: false, working: true, attention: 13 })).toEqual({ kind: 'working', count: 13 });
    expect(tabSlotSignal({ frozen: false, working: true, attention: 0 })).toEqual({ kind: 'working', count: 0 });
  });

  test('attention alone is the number', () => {
    expect(tabSlotSignal({ frozen: false, working: false, attention: 3 })).toEqual({ kind: 'attention', count: 3 });
  });

  test('nothing at all leaves the slot empty, and a negative count is nothing', () => {
    expect(tabSlotSignal({ frozen: false, working: false, attention: 0 })).toEqual({ kind: 'none' });
    expect(tabSlotSignal({ frozen: false, working: false, attention: -1 })).toEqual({ kind: 'none' });
  });
});

describe('tabSlotCommand', () => {
  test('a live stoppable turn makes the slot Stop, never Stop and Close together', () => {
    expect(tabSlotCommand({ canStop: true, closable: true, isProject: false })).toBe('stop');
  });

  test('once stopped, the same slot is Close', () => {
    expect(tabSlotCommand({ canStop: false, closable: true, isProject: false })).toBe('close');
  });

  test('a project tab never offers Stop', () => {
    expect(tabSlotCommand({ canStop: true, closable: true, isProject: true })).toBe('close');
  });

  test('a pane the host does not let close still stops, and otherwise has no command', () => {
    expect(tabSlotCommand({ canStop: true, closable: false, isProject: false })).toBe('stop');
    expect(tabSlotCommand({ canStop: false, closable: false, isProject: false })).toBeNull();
  });
});
