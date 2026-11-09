import { useMemo } from 'react';
import type { BoardProjectRef, BoardTask } from '../../lib/board';
import { resolveProjectRefs } from '../../lib/boardProjectsStore';
import { splitIntoLanes, taskWaitsOnPerson, withDraftLane, type BoardLane } from './boardLanes';
import { draftLaneOf, type DraftPlacement, type DraftPreview } from './draftPreview';

/**
 * The lanes of the grouped board, in ONE place: the cards split per project, the
 * composer's ghost kept to a single spot (its project's lane, a temporary lane of
 * that project when it has no card yet, or above the lanes on «Automatico»), and
 * the name shown on each lane.
 */
export function useProjectLanes({ grouped, showArchived, draft, tasks, byColumn, columnIds, projectIndex }: {
  grouped: boolean;
  showArchived: boolean;
  draft: DraftPreview | null | undefined;
  tasks: readonly BoardTask[];
  byColumn: ReadonlyMap<string, BoardTask[]>;
  columnIds: readonly string[];
  projectIndex: BoardProjectRef[] | null;
}): { lanes: BoardLane[]; draftPlacement: DraftPlacement | null; draftLane: string | null; laneNameById: Map<string, string> } {
  const taskLanes = useMemo<BoardLane[]>(() => {
    if (!grouped) return [];
    const names = new Map(resolveProjectRefs([...new Set(tasks.map((t) => t.projectId))], projectIndex).map((p) => [p.projectId, p.name]));
    // Archived cards wait for no one (the Plan reads live cards only).
    return splitIntoLanes(byColumn, columnIds, (id) => names.get(id) ?? id, showArchived ? () => false : taskWaitsOnPerson);
  }, [grouped, showArchived, tasks, byColumn, columnIds, projectIndex]);
  const draftPlacement = useMemo(
    () => (grouped && !showArchived ? draftLaneOf(draft ?? null, taskLanes.map((l) => l.projectId)) : null),
    [grouped, showArchived, draft, taskLanes],
  );
  const lanes = useMemo(
    () => withDraftLane(taskLanes, draftPlacement, columnIds, (id) => resolveProjectRefs([id], projectIndex)[0]?.name ?? id),
    [taskLanes, draftPlacement, columnIds, projectIndex],
  );
  const laneNameById = useMemo(
    () => new Map(resolveProjectRefs(lanes.map((l) => l.projectId), projectIndex).map((p) => [p.projectId, p.name])),
    [lanes, projectIndex],
  );
  const draftLane = draftPlacement && draftPlacement.kind !== 'above' ? draftPlacement.projectId : null;
  return { lanes, draftPlacement, draftLane, laneNameById };
}
