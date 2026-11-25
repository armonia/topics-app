import type { BoardTask } from '../../lib/board';
import { MY_WORK_PRESET, NO_FILTERS, type BoardFilters } from './constants';
import { cardOwner, matchesChannels } from './cardOrigin';
import { taskWaitsOnPerson } from './boardLanes';

export function runInitiatorName(
  task: Pick<BoardTask, 'runInitiatorPersonName' | 'runInitiatorDeviceName'>,
): string {
  return task.runInitiatorPersonName || task.runInitiatorDeviceName || '';
}

/** What the filters need from outside the card: the name of the person using the app (for «you»). */
export interface FilterContext { personName: string | null }

/** Which axes to leave out, so a count can say what its own choice would show. */
export interface FilterSkip { owners?: boolean; channels?: boolean; needsMe?: boolean }

/** Match one already-visible task. Every active axis is an additional gate. */
export function taskMatchesFilters(task: BoardTask, filters: BoardFilters, ctx: FilterContext = { personName: null }, skip: FilterSkip = {}): boolean {
  if (filters.priority.length > 0 && !filters.priority.includes(task.priority)) return false;
  if (filters.assignedTo.length > 0 && !filters.assignedTo.includes(task.assignedTo || '')) return false;
  if (filters.person.length > 0 && !filters.person.includes(task.lastActorPersonName || '')) return false;
  if (filters.computer.length > 0 && !filters.computer.includes(task.lastActorDeviceName || '')) return false;
  if (filters.initiator.length > 0 && !filters.initiator.includes(runInitiatorName(task))) return false;
  if (filters.runComputer.length > 0 && !filters.runComputer.includes(task.runComputerName || '')) return false;
  if (filters.text && !task.text.toLowerCase().includes(filters.text.toLowerCase())) return false;
  if (filters.projectId.length > 0 && !filters.projectId.includes(task.projectId)) return false;
  if (filters.labels.length > 0) {
    const labels = new Set(task.labels.map((label) => label.label));
    if (!filters.labels.every((label) => labels.has(label))) return false;
  }
  if (filters.hideInProgress && task.status === 'in_progress') return false;
  if (!skip.owners && filters.owners?.length && !filters.owners.includes(cardOwner(task, ctx.personName).key)) return false;
  if (!skip.channels && filters.channels?.length && !matchesChannels(task, filters.channels)) return false;
  if (!skip.needsMe && filters.needsMe && !taskWaitsOnPerson(task)) return false;
  return true;
}

/** The filters as «My work» leaves them: the same as `preset`, or something else. */
export function isPreset(filters: BoardFilters, preset: { owners: readonly string[]; channels: readonly string[]; hideInProgress: boolean }): boolean {
  const same = (a: readonly string[] = [], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));
  return same(filters.owners, preset.owners) && same(filters.channels, preset.channels) && !!filters.hideInProgress === preset.hideInProgress;
}

/** Where the last preset picked is kept, for every board: a board seen for the first time opens on it. */
export const BOARD_PRESET_STORAGE_KEY = 'topics.board.preset';
export type BoardPreset = 'mine' | 'all';

export function presetFilters(preset: BoardPreset): Pick<BoardFilters, 'owners' | 'channels' | 'hideInProgress' | 'needsMe'> {
  return preset === 'all'
    ? { owners: [], channels: [], hideInProgress: false, needsMe: false }
    : { owners: [...MY_WORK_PRESET.owners], channels: [], hideInProgress: MY_WORK_PRESET.hideInProgress, needsMe: false };
}

/**
 * The filters a board opens with. A board with its own saved filters keeps
 * them; one saved before the origin axes existed (`v` below 2), or never
 * saved, opens on the last preset the person picked, «My work» by default.
 */
export function initialBoardFilters(stored: string | null, lastPreset: string | null): BoardFilters {
  let parsed: (Partial<BoardFilters> & { v?: number }) | null = null;
  try { parsed = stored ? JSON.parse(stored) : null; } catch { parsed = null; }
  const origin = parsed && (parsed.v ?? 0) >= 2 ? {} : presetFilters(lastPreset === 'all' ? 'all' : 'mine');
  const { v: _v, ...rest } = parsed ?? {};
  return { ...NO_FILTERS, ...rest, ...origin };
}
