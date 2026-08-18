/**
 * topicId → the task that runs (or ran) in it, derived from the board feed.
 *
 * Pure on purpose: it is the only part of `useTaskTopicIndex` with a rule in it
 * (only dispatched tasks, and the last row of the feed wins a topic), and the
 * hook around it is now nothing but a `useMemo` over the shared store.
 *
 * Two shapes out of one pass because there are two consumers and they want
 * different fields: the resolver answers the completion notifier, which needs
 * `dispatchState` to know whether an agent is working RIGHT NOW, while the chat
 * store also shows the task's `text` (a bare id on the return line would say
 * nothing).
 */
import type { BoardTask, TaskStatus } from './board';
import type { TopicTaskRef as StoreTaskRef } from '../state/taskSessions';

/** Il task che gira (o è girato) in un topic. */
export interface TopicTaskRef {
  taskId: string;
  /** Colonna kanban corrente (backlog | todo | in_progress | review | done). */
  status: TaskStatus;
  /** null = non dispatchato; queued | starting | working | waiting | delivered | … */
  dispatchState: string | null;
}

export interface TopicTaskIndex {
  /** Per il risolutore stabile del notificatore. */
  byTopic: Map<string, TopicTaskRef>;
  /** Per `state/taskSessions`, che sostituisce l'indice INTERO a ogni giro. */
  forStore: Record<string, StoreTaskRef>;
}

export function buildTopicTaskIndex(tasks: readonly BoardTask[]): TopicTaskIndex {
  const byTopic = new Map<string, TopicTaskRef>();
  const forStore: Record<string, StoreTaskRef> = {};
  for (const t of tasks) {
    if (!t.assignedTopicId) continue;
    byTopic.set(t.assignedTopicId, { taskId: t.id, status: t.status, dispatchState: t.dispatchState });
    forStore[t.assignedTopicId] = { taskId: t.id, text: t.text, status: t.status, dispatchState: t.dispatchState };
  }
  return { byTopic, forStore };
}
