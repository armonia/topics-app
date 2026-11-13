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

/** The cards `topicId` opened that are still going: what its sidebar row and waiting line name. */
export function openCardsOf(tasks: readonly BoardTask[], topicId: string, extraIds: ReadonlySet<string> = new Set()): BoardTask[] {
  return tasks.filter((t) => (t.openerTopicId === topicId || extraIds.has(t.id)) && isAwaitedPhase(taskCardPhase(t)));
}
