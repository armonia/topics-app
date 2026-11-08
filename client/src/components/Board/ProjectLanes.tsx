/**
 * The board grouped by project (one lane per project, `boardLanes.ts`) and the
 * two toolbar controls that choose how the board is read: grouping and card
 * density. Out of `KanbanBoardPane` so the pane keeps its size budget.
 */
import { useMemo, type ReactNode } from 'react';
import { Layers, ListCollapse } from 'lucide-react';
import { useT } from '../../hooks/useT';
import type { WorkflowColumn } from '../../../../shared/workflow';
import type { BoardDensity, BoardGroupBy, BoardLayout } from './boardGeometry';
import { splitIntoLanes, withDraftLane, type BoardLane } from './boardLanes';
import { resolveProjectRefs } from '../../lib/boardProjectsStore';
import type { BoardProjectRef, BoardTask } from '../../lib/board';
import { TOOLBAR_CONTROL_H, TOOLBAR_ICON_W } from './constants';
import { LaneCounts, ProjectGroupHeader } from './ProjectGroupHeader';
import { DraftCard } from './DraftCard';
import { draftLaneOf, type DraftPlacement, type DraftPreview } from './draftPreview';

const toggleClass = (on: boolean) =>
  `grid ${TOOLBAR_CONTROL_H} ${TOOLBAR_ICON_W} shrink-0 place-items-center rounded ${on ? 'bg-white/15 text-primary' : 'text-app-text-secondary hover:bg-white/5'}`;

/**
 * GROUP BY PROJECT and COMPACT CARDS: two view choices in the same spot and
 * style as the layout toggle, not a menu. Grouping only exists on the
 * cross-project board, where there is more than one project to group.
 */
export function BoardViewToggles({ canGroup, groupBy, onGroupBy, density, onDensity }: {
  canGroup: boolean;
  groupBy: BoardGroupBy; onGroupBy: (next: (v: BoardGroupBy) => BoardGroupBy) => void;
  density: BoardDensity; onDensity: (next: (v: BoardDensity) => BoardDensity) => void;
}) {
  const tr = useT();
  return <>
    {canGroup && (
      <button
        type="button" data-testid="board-group-toggle" aria-pressed={groupBy === 'project'}
        onClick={() => onGroupBy((v) => (v === 'project' ? 'none' : 'project'))}
        className={toggleClass(groupBy === 'project')}
        title={tr(groupBy === 'project' ? 'board.toolbar.groupBy.off' : 'board.toolbar.groupBy.project')}
      ><Layers className="h-3.5 w-3.5" /></button>
    )}
    <button
      type="button" data-testid="board-density-toggle" aria-pressed={density === 'compact'}
      onClick={() => onDensity((v) => (v === 'compact' ? 'full' : 'compact'))}
      className={toggleClass(density === 'compact')}
      title={tr(density === 'compact' ? 'board.toolbar.density.full' : 'board.toolbar.density.compact')}
    ><ListCollapse className="h-3.5 w-3.5" /></button>
  </>;
}

/** One lane per project: its header (icon, name, fold, counts) and the board's own row of columns. */
export function ProjectLanes({ lanes, columns, layout, nameById, pathById, collapsed, onToggle, draftAbove, draftLane, renderColumn }: {
  lanes: readonly BoardLane[];
  columns: readonly WorkflowColumn[];
  layout: BoardLayout;
  nameById: ReadonlyMap<string, string>;
  pathById: ReadonlyMap<string, string>;
  collapsed: ReadonlySet<string>;
  onToggle: (projectId: string) => void;
  /** The composer's ghost when it belongs to no project yet («Automatico»): above the lanes, no project header. */
  draftAbove?: DraftPreview;
  /** The project whose lane holds the ghost: that lane stays open even if folded, or the ghost would vanish. */
  draftLane?: string | null;
  renderColumn: (column: WorkflowColumn, tasks: BoardTask[], lane: BoardLane) => ReactNode;
}) {
  return <>
    {draftAbove && (
      <div data-testid="board-draft-above" className={`shrink-0 ${layout === 'list' ? 'mx-auto w-full max-w-3xl' : 'w-full max-w-sm'}`}>
        <DraftCard draft={draftAbove} />
      </div>
    )}
    {lanes.map((lane) => {
      const folded = collapsed.has(lane.projectId) && lane.projectId !== draftLane;
      return (
        <section key={lane.projectId} data-testid="board-lane" data-project-id={lane.projectId} data-collapsed={folded || undefined}
          className={`flex shrink-0 flex-col gap-2 ${layout === 'list' ? 'mx-auto w-full max-w-3xl' : ''}`}>
          <ProjectGroupHeader
            projectId={lane.projectId}
            name={nameById.get(lane.projectId) ?? lane.projectId}
            path={pathById.get(lane.projectId)}
            collapsed={folded}
            onToggle={() => onToggle(lane.projectId)}
            testId="board-lane-header"
          >
            <LaneCounts lane={lane} columns={columns} />
          </ProjectGroupHeader>
          {!folded && (
            <div className={layout === 'list' ? 'flex flex-col gap-2' : 'flex min-w-0 gap-2 overflow-x-auto pb-1 sm:gap-3'}>
              {columns.map((column) => renderColumn(column, lane.columns.get(column.id) ?? [], lane))}
            </div>
          )}
        </section>
      );
    })}
  </>;
}

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
    return splitIntoLanes(byColumn, columnIds, (id) => names.get(id) ?? id);
  }, [grouped, tasks, byColumn, columnIds, projectIndex]);
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
