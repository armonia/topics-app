import type { BoardTask } from '../../lib/board';
import type { BoardFilters } from './constants';

/** Match one already-visible task. Every active axis is an additional gate. */
export function taskMatchesFilters(task: BoardTask, filters: BoardFilters): boolean {
  if (filters.priority.length > 0 && !filters.priority.includes(task.priority)) return false;
  if (filters.assignedTo.length > 0 && !filters.assignedTo.includes(task.assignedTo || '')) return false;
  if (filters.person.length > 0 && !filters.person.includes(task.lastActorPersonName || '')) return false;
  if (filters.computer.length > 0 && !filters.computer.includes(task.lastActorDeviceName || '')) return false;
  if (filters.initiator.length > 0 && !filters.initiator.includes(task.runInitiatorPersonName || '')) return false;
  if (filters.runComputer.length > 0 && !filters.runComputer.includes(task.runComputerName || '')) return false;
  if (filters.text && !task.text.toLowerCase().includes(filters.text.toLowerCase())) return false;
  if (filters.projectId.length > 0 && !filters.projectId.includes(task.projectId)) return false;
  if (filters.labels.length > 0) {
    const labels = new Set(task.labels.map((label) => label.label));
    if (!filters.labels.every((label) => labels.has(label))) return false;
  }
  return true;
}
