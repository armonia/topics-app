/**
 * WHERE A CARD IS, in the words a chat uses for it.
 *
 * The board has five columns and a dispatch state; a chat that opened a card
 * wants one answer: waiting, working, delivered, done or failed. The transcript
 * card, the waiting line and the sidebar read it from here so they never
 * disagree about the same card.
 */
import type { BoardTask } from './board';

export type TaskCardPhase = 'backlog' | 'todo' | 'working' | 'review' | 'done' | 'failed';

type PhaseInput = Pick<BoardTask, 'status' | 'dispatchState'>;

export function taskCardPhase(task: PhaseInput): TaskCardPhase {
  if (task.status === 'done') return 'done';
  if (task.dispatchState === 'failed') return 'failed';
  if (task.status === 'in_progress') return 'working';
  return task.status;
}

/** A card the chat that sent it to work is still waiting on. */
export function isAwaitedPhase(phase: TaskCardPhase): boolean {
  return phase === 'todo' || phase === 'working';
}

/**
 * Is a chat really waiting on this card? A card in `todo` is in the dispatcher's
 * queue and will be picked up. One in `in_progress` is waited on only while an
 * agent has it (`dispatchState` set): a card moved there by hand,
 * or by a sub-agent's `update_task`, has no `dispatchState` and nobody on it,
 * so no outcome will ever wake the chat (`card-outcome-wake`). Counted, it kept
 * the line «waiting on a background job» up for five hours on a chat that had
 * nothing running (17/11, topic bdace50c).
 */
export function isAwaitedCard(task: Pick<BoardTask, 'status' | 'dispatchState'>): boolean {
  const phase = taskCardPhase(task);
  if (!isAwaitedPhase(phase)) return false;
  // A card in `working` with no dispatch state at all was never given to an agent.
  return phase !== 'working' || !!task.dispatchState;
}

/** The cards `topicId` opened that are still going: what its sidebar row and waiting line name. */
export function openCardsOf(tasks: readonly BoardTask[], topicId: string, extraIds: ReadonlySet<string> = new Set()): BoardTask[] {
  return tasks.filter((t) => (t.openerTopicId === topicId || extraIds.has(t.id)) && isAwaitedCard(t));
}

/** The one phase to glyph map: the chat card draws these with `StatusIcon`. */
export const PHASE_GLYPH: Record<TaskCardPhase, 'backlog' | 'todo' | 'in_progress' | 'review' | 'done' | 'failed'> = {
  backlog: 'backlog',
  todo: 'todo',
  working: 'in_progress',
  review: 'review',
  done: 'done',
  failed: 'failed',
};
