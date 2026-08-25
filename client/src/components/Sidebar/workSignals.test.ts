/**
 * THE CHIP HAS THREE SLOTS AND FIVE CANDIDATES, so the interesting cases are
 * the ones where something has to be LEFT OUT.
 *
 *  1. A zero never takes a slot: it is the widest way of saying nothing.
 *  2. What is dropped is the least urgent, not the last one written.
 *  3. What is dropped is never the open-session count while something quieter
 *     stays: "how much is going on in here" is the question the chip exists to
 *     answer.
 */
import { describe, it, expect } from 'bun:test';
import { workSignals, type WorkCounts } from './workSignals';

const zero: WorkCounts = {
  openSessions: 0,
  workingSessions: 0,
  activeTasks: 0,
  awaitingInput: 0,
  awaitingDone: 0,
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
    const s = workSignals({ ...zero, openSessions: 12, workingSessions: 3 });
    expect(s.map((x) => x.kind)).toEqual(['working', 'open']);
  });

  it('with five candidates it keeps three, and the first to fall is the least urgent', () => {
    const s = workSignals({
      openSessions: 12,
      workingSessions: 3,
      activeTasks: 2,
      awaitingInput: 1,
      awaitingDone: 4,
    });
    expect(s.map((x) => x.kind)).toEqual(['working', 'awaitingInput', 'done']);
    // The board tasks fall, and so does the open count: the three that stay are
    // the ones that mean somebody is waiting for you.
    expect(s.map((x) => x.n)).toEqual([3, 1, 4]);
  });

  it('the session count survives even when the tasks fall', () => {
    const s = workSignals({ ...zero, openSessions: 12, workingSessions: 3, activeTasks: 2 });
    expect(s.map((x) => x.kind)).toEqual(['working', 'tasks', 'open']);
    const narrower = workSignals({ ...zero, openSessions: 12, workingSessions: 3, activeTasks: 2 }, 2);
    expect(narrower.map((x) => x.kind)).toEqual(['working', 'open']);
  });
});
