/**
 * WHY this pane is dormant, read off the card the session belonged to.
 *
 * The pane already knew it was dormant: what it could not say was the cause.
 * On 2026-09-14 a restart cut twelve cards mid-turn and every one of their
 * sub-agent panes showed the same generic "Session ended", while the board card
 * sat in progress waiting for memory. From the pane there was no cause, no time
 * and no way back to the card, so it read as "stuck, full stop".
 *
 * The decision is HERE, pure and testable, and the words are in the component:
 * the bug this file exists for is not a rendering bug, it is choosing what to
 * say when three facts are true at once.
 */
import type { BoardTask, QueueReason, TaskStatus } from '../../lib/board';

export type DormantCause =
  /** The card is working again, in a DIFFERENT topic: there is somewhere to go. */
  | { kind: 'resumed'; topicId: string }
  /** The card is waiting in the queue, in the server's own words. */
  | { kind: 'queued'; reason: QueueReason }
  /** A server shutdown cut this turn in half. */
  | { kind: 'interrupted'; at: string; status: TaskStatus }
  /** Nothing can be said honestly: the pane keeps the overlay it has today. */
  | null;

/**
 * The cause line for a dormant session, or `null` for "say nothing new".
 *
 * ORDER OF PRECEDENCE, and it is not the order the three facts were listed in.
 * A single card can carry all three (cut by the restart, then queued, then
 * restarted elsewhere), so the pane shows the one that answers "what do I do
 * now":
 *
 *  1. `resumed` — the work moved to another session. That is a place to click,
 *     and it also tells the reader that THIS pane is history, which neither of
 *     the other two do.
 *  2. `queued` — the card has not restarted yet and the server already wrote
 *     the sentence saying what it waits on and that it restarts by itself.
 *  3. `interrupted` — the last turn was cut and nothing has moved since.
 *
 * No card, or a card with none of the three: `null`. Nothing is invented here.
 */
export function dormantCause(
  topicId: string | null | undefined,
  task: BoardTask | null,
): DormantCause {
  if (!task) return null;
  if (topicId && task.assignedTopicId && task.assignedTopicId !== topicId) {
    return { kind: 'resumed', topicId: task.assignedTopicId };
  }
  if (task.queueReason) return { kind: 'queued', reason: task.queueReason };
  if (task.interruptedAt) {
    return { kind: 'interrupted', at: task.interruptedAt, status: task.status };
  }
  return null;
}

/** HH:MM of an ISO instant, in the reader's own clock. Empty on an unparsable
 *  value: a wrong hour is worse than no hour. */
export function causeClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
