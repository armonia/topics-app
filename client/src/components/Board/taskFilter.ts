import type { BoardTask } from '../../lib/board';
import { splitCreatedBy } from '../../../../shared/created-by';
import { taskWaitsOnPerson } from './boardLanes';
import type { BoardFilters, QuickFilter } from './constants';
import { creatorKind } from './createdByLabel';

/** The rule behind each one-click chip, so the board, the list and the Plan agree on who is in it. */
export function taskMatchesQuick(task: BoardTask, quick: QuickFilter): boolean {
  const by = splitCreatedBy(task.createdBy);
  switch (quick) {
    case 'needsYou': return task.status !== 'done' && taskWaitsOnPerson(task);
    case 'jarvis': return by?.kind === 'agent' && by.name === 'jarvis';
    case 'agents': return by?.kind === 'agent';
    case 'scheduled': return !!task.scheduled || by?.kind === 'cron';
  }
}

/** Any axis narrowing the board: the Plan only filters its cards when this is true. */
export function filtersActive(filters: BoardFilters): boolean {
  return (filters.quick?.length ?? 0) > 0 || filters.text !== '' || (filters.creator !== undefined && filters.creator !== 'all')
    || [filters.priority, filters.assignedTo, filters.person, filters.computer, filters.initiator, filters.runComputer, filters.projectId, filters.labels]
      .some((axis) => axis.length > 0);
}

export function runInitiatorName(
  task: Pick<BoardTask, 'runInitiatorPersonName' | 'runInitiatorDeviceName'>,
): string {
  return task.runInitiatorPersonName || task.runInitiatorDeviceName || '';
}

/** Match one already-visible task. Every active axis is an additional gate. */
export function taskMatchesFilters(task: BoardTask, filters: BoardFilters): boolean {
  if (filters.priority.length > 0 && !filters.priority.includes(task.priority)) return false;
  if (filters.assignedTo.length > 0 && !filters.assignedTo.includes(task.assignedTo || '')) return false;
  if (filters.person.length > 0 && !filters.person.includes(task.lastActorPersonName || '')) return false;
  if (filters.computer.length > 0 && !filters.computer.includes(task.lastActorDeviceName || '')) return false;
  if (filters.initiator.length > 0 && !filters.initiator.includes(runInitiatorName(task))) return false;
  if (filters.runComputer.length > 0 && !filters.runComputer.includes(task.runComputerName || '')) return false;
  if (filters.text && !task.text.toLowerCase().includes(filters.text.toLowerCase())) return false;
  if (filters.projectId.length > 0 && !filters.projectId.includes(task.projectId)) return false;
  // `mine` is a person's cards; `others` is what an agent or a schedule opened.
  // A card with no author (born before the field) is neither: only `all` shows it.
  if (filters.creator === 'mine' && creatorKind(task.createdBy) !== 'human') return false;
  if (filters.creator === 'others' && creatorKind(task.createdBy) !== 'other') return false;
  if (filters.quick && !filters.quick.every((q) => taskMatchesQuick(task, q))) return false;
  if (filters.labels.length > 0) {
    const labels = new Set(task.labels.map((label) => label.label));
    if (!filters.labels.every((label) => labels.has(label))) return false;
  }
  return true;
}
