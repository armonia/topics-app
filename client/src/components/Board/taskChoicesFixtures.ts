import type { BoardTask } from '../../lib/board';
import { reviewDecisionButtons } from './taskActionWords';
import { taskChoices, type TaskChoiceId } from './taskChoices';

export type ChoiceInput = Parameters<typeof taskChoices>[0];

/** Only the fields the choices are born from: the rest of the card does not matter here. */
export function task(over: Partial<ChoiceInput> = {}): ChoiceInput {
  return {
    status: 'todo' as BoardTask['status'],
    assignedTopicId: null,
    deliveryBranch: null,
    // Branch-bearing fixtures represent a measured code delivery by default.
    deliveryFilesChanged: 1,
    dispatchState: null,
    blockedByTaskId: null,
    blockedBy: null,
    // Nobody has brought it to review yet: this is the "normal" card that
    // almost all the cases below start from.
    deliveredBy: null,
    deliveredReason: null,
    // Pre-review checks not run: the "normal" card is not an exception, and the
    // words stay plain.
    checksState: null,
    ...over,
  };
}

/** The fields the drawer's BIG buttons need (a different Pick). */
export function drawerTask(over: Partial<Parameters<typeof reviewDecisionButtons>[0]> = {}): Parameters<typeof reviewDecisionButtons>[0] {
  return {
    status: 'review' as BoardTask['status'],
    assignedTopicId: 'top-1',
    deliveryBranch: 'task/review',
    deliveryFilesChanged: 1,
    checksState: null,
    deliveredBy: 'agent',
    deliveredReason: null,
    ...over,
  };
}
export const ids = (t: ChoiceInput, opts?: { exclude?: TaskChoiceId[] }) => taskChoices(t, opts).map((c) => c.id);
