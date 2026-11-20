import type { BoardTask } from '../../lib/board';
import { API_CALLER_CREATED_BY, splitCreatedBy } from '../../../../shared/created-by';
import { taskWaitsOnPerson } from './boardLanes';
import type { BoardFilters } from './constants';
import { taskMatchesFilters } from './taskFilter';

/** One-click filters above the board: who has to act, or who opened the card. */
export const QUICK_FILTERS = ['me', 'jarvis', 'agents', 'scheduled'] as const;
export type QuickFilter = (typeof QUICK_FILTERS)[number];

// `agent:api` is what a board-API caller that names nobody gets (Jarvis's own cards among them).
const JARVIS_NAMES = ['jarvis', API_CALLER_CREATED_BY.slice('agent:'.length)];

export function taskMatchesQuick(task: BoardTask, quick: QuickFilter): boolean {
  const by = splitCreatedBy(task.createdBy);
  // Same rule as the creator chip: a card with a Jarvis channel behind it is Jarvis's work,
  // even when `createdBy` is empty (cards born before the field).
  const fromChannel = !!task.channel?.topicId;
  switch (quick) {
    case 'me': return taskWaitsOnPerson(task);
    case 'jarvis': return fromChannel || (by?.kind === 'agent' && JARVIS_NAMES.includes(by.name?.toLowerCase() ?? ''));
    case 'agents': return fromChannel || by?.kind === 'agent';
    case 'scheduled': return by?.kind === 'cron' || !!task.scheduled;
  }
}

/** One count per quick filter, over the cards given (the caller leaves the creator toggle out). */
export function countQuickFilters(tasks: readonly BoardTask[]): Record<QuickFilter, number> {
  const out: Record<QuickFilter, number> = { me: 0, jarvis: 0, agents: 0, scheduled: 0 };
  for (const task of tasks) for (const q of QUICK_FILTERS) if (taskMatchesQuick(task, q)) out[q] += 1;
  return out;
}

/** Counts over the cards the other filters let through, with the creator toggle left out so «mine» cannot zero them. */
export function countQuickFiltersWithoutCreator(tasks: readonly BoardTask[], filters: BoardFilters): Record<QuickFilter, number> {
  return countQuickFilters(tasks.filter((task) => taskMatchesFilters(task, { ...filters, creator: 'all' })));
}
