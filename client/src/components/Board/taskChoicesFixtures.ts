import type { BoardTask } from '../../lib/board';
import { reviewDecisionButtons } from './taskActionWords';
import { taskChoices, type TaskChoiceId } from './taskChoices';

export type ChoiceInput = Parameters<typeof taskChoices>[0];

/** Solo i campi da cui nascono le scelte: il resto della card non c'entra. */
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
    // Nessuno l'ha ancora portata in review: è la card «normale» da cui partono
    // quasi tutti i casi qui sotto.
    deliveredBy: null,
    deliveredReason: null,
    // Pre-review checks not run: the "normal" card is not an exception, and the
    // words stay plain.
    checksState: null,
    ...over,
  };
}

/** I campi che servono ai bottoni GRANDI del drawer (un Pick diverso). */
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
