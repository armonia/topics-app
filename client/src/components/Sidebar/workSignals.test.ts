/**
 * THE TAIL CARRIES TWO NUMBERS AND NEVER A THIRD, so what is worth proving is
 * which two they are and when they are absent.
 *
 *  1. A zero never takes a slot: it is the widest way of saying nothing.
 *  2. What is alive is read first, the inventory last.
 *  3. There is no cut to make any more: the counts that used to compete for a
 *     slot (waiting, unread turns, board tasks) are not candidates at all.
 *
 * @covers STATUSLINE-01
 */
import { describe, it, expect } from 'bun:test';
import { workSignals, type WorkCounts } from './workSignals';

const zero: WorkCounts = {
  openSessions: 0,
  workingSessions: 0,
};

describe('workSignals', () => {
  it('a quiet machine draws nothing', () => {
    expect(workSignals(zero)).toEqual([]);
  });

  it('skips the zeros and keeps only what exists', () => {
    const s = workSignals({ ...zero, openSessions: 12 });
    expect(s).toEqual([{ kind: 'open', n: 12 }]);
  });

  it('puts what is alive first and the inventory last', () => {
    const s = workSignals({ openSessions: 12, workingSessions: 3 });
    expect(s).toEqual([{ kind: 'working', n: 3 }, { kind: 'open', n: 12 }]);
  });

  it('never draws a third number, however busy the machine is', () => {
    const s = workSignals({ openSessions: 12, workingSessions: 3 });
    expect(s.length).toBeLessThanOrEqual(2);
  });
});
