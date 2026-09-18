/**
 * The four branches of the dormant cause, and the order they argue in.
 *
 * @covers TERM-12
 */
import { describe, expect, it } from 'bun:test';
import { causeClock, dormantCause } from './dormantCause';
import type { BoardTask, QueueReason } from '../../lib/board';

const REASON: QueueReason = {
  kind: 'resource_floor',
  key: 'board.queue.floor',
  params: { free: '4,2 GB', floor: '6 GB' },
  tone: 'stalled',
} as unknown as QueueReason;

function card(patch: Partial<BoardTask>): BoardTask {
  return {
    id: 't1',
    status: 'in_progress',
    assignedTopicId: null,
    queueReason: null,
    ...patch,
  } as unknown as BoardTask;
}

describe('dormantCause', () => {
  it('says nothing when the session has no card', () => {
    expect(dormantCause('topic-1', null)).toBeNull();
  });

  it('says nothing when the card carries none of the three facts', () => {
    expect(dormantCause('topic-1', card({ assignedTopicId: 'topic-1' }))).toBeNull();
  });

  it('reads the interruption, with its instant and the card status', () => {
    const c = dormantCause('topic-1', card({
      assignedTopicId: 'topic-1',
      interruptedAt: '2026-09-14T23:03:00.000Z',
      status: 'in_progress',
    }));
    expect(c).toEqual({ kind: 'interrupted', at: '2026-09-14T23:03:00.000Z', status: 'in_progress' });
  });

  it('reads the queue reason the server already wrote', () => {
    const c = dormantCause('topic-1', card({ assignedTopicId: 'topic-1', queueReason: REASON }));
    expect(c).toEqual({ kind: 'queued', reason: REASON });
  });

  it('points at the new session when the card is bound to another topic', () => {
    const c = dormantCause('topic-1', card({ assignedTopicId: 'topic-2' }));
    expect(c).toEqual({ kind: 'resumed', topicId: 'topic-2' });
  });

  it('prefers the new session over the queue and over the interruption', () => {
    const c = dormantCause('topic-1', card({
      assignedTopicId: 'topic-2',
      queueReason: REASON,
      interruptedAt: '2026-09-14T23:03:00.000Z',
    }));
    expect(c).toEqual({ kind: 'resumed', topicId: 'topic-2' });
  });

  it('prefers the queue over the interruption: it is the fact that says what happens next', () => {
    const c = dormantCause('topic-1', card({
      assignedTopicId: 'topic-1',
      queueReason: REASON,
      interruptedAt: '2026-09-14T23:03:00.000Z',
    }));
    expect(c).toEqual({ kind: 'queued', reason: REASON });
  });

  it('does not call a card "resumed" when the pane has no topic of its own', () => {
    expect(dormantCause(null, card({ assignedTopicId: 'topic-2' }))).toBeNull();
  });
});

describe('causeClock', () => {
  it('renders hours and minutes padded', () => {
    const at = new Date(2026, 8, 14, 9, 3).toISOString();
    expect(causeClock(at)).toBe('09:03');
  });

  it('returns nothing on an unparsable instant, rather than a wrong hour', () => {
    expect(causeClock('not an instant')).toBe('');
  });
});

describe('the exit code', () => {
  it('speaks when no card fact does', () => {
    expect(dormantCause('topic-a', null, 137)).toEqual({ kind: 'exited', code: 137 });
  });

  it('yields to a card that was cut by a restart', () => {
    const task = { id: 't', status: 'in_progress', interruptedAt: '2026-09-14T23:03:00Z' } as never;
    expect(dormantCause('topic-a', task, 143)).toMatchObject({ kind: 'interrupted' });
  });

  it('is absent, not zero, when the bridge recorded none', () => {
    expect(dormantCause('topic-a', null, null)).toBeNull();
  });
});
