import type { BoardTask } from '../../lib/board';
import { splitCreatedBy } from '../../../../shared/created-by';
import { taskWaitsOnPerson } from './boardLanes';

/** One-click filters above the board: who has to act, or who opened the card. */
export const QUICK_FILTERS = ['me', 'jarvis', 'agents', 'scheduled'] as const;
export type QuickFilter = (typeof QUICK_FILTERS)[number];

const JARVIS_NAME = 'jarvis';

export function taskMatchesQuick(task: BoardTask, quick: QuickFilter): boolean {
  const by = splitCreatedBy(task.createdBy);
  switch (quick) {
    case 'me': return taskWaitsOnPerson(task);
    case 'jarvis': return by?.kind === 'agent' && by.name?.toLowerCase() === JARVIS_NAME;
    case 'agents': return by?.kind === 'agent';
    case 'scheduled': return by?.kind === 'cron' || !!task.scheduled;
  }
}

/** One count per quick filter, over the cards that already pass the other filters. */
export function countQuickFilters(tasks: readonly BoardTask[]): Record<QuickFilter, number> {
  const out: Record<QuickFilter, number> = { me: 0, jarvis: 0, agents: 0, scheduled: 0 };
  for (const task of tasks) for (const q of QUICK_FILTERS) if (taskMatchesQuick(task, q)) out[q] += 1;
  return out;
}
