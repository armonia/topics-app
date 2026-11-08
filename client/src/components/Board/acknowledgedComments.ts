import type { TaskComment } from '../../../../shared/board';

/** A read can confirm an acknowledgement, but cannot retract a successful POST. */
export function reconcileAcknowledgedComments(
  incoming: TaskComment[],
  acknowledged: Map<string, TaskComment>,
): TaskComment[] {
  for (const comment of incoming) acknowledged.delete(comment.id);
  if (acknowledged.size === 0) return incoming;
  return [...incoming, ...acknowledged.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
