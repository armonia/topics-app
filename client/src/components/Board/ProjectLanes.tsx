/**
 * The board grouped by project (one lane per project, `boardLanes.ts`) and the
 * two toolbar controls that choose how the board is read: grouping and card
 * density. Out of `KanbanBoardPane` so the pane keeps its size budget.
 */
import type { ReactNode } from 'react';
import { Layers, ListCollapse } from 'lucide-react';
import { useT } from '../../hooks/useT';
import type { WorkflowColumn } from '../../../../shared/workflow';
import type { BoardDensity, BoardGroupBy, BoardLayout } from './boardGeometry';
import type { BoardLane } from './boardLanes';
import type { BoardTask } from '../../lib/board';
import { TOOLBAR_CONTROL_H, TOOLBAR_ICON_W } from './constants';
import { LaneCounts, ProjectGroupHeader } from './ProjectGroupHeader';

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
export function ProjectLanes({ lanes, columns, layout, nameById, pathById, collapsed, onToggle, renderColumn }: {
  lanes: readonly BoardLane[];
  columns: readonly WorkflowColumn[];
  layout: BoardLayout;
  nameById: ReadonlyMap<string, string>;
  pathById: ReadonlyMap<string, string>;
  collapsed: ReadonlySet<string>;
  onToggle: (projectId: string) => void;
  renderColumn: (column: WorkflowColumn, tasks: BoardTask[], lane: BoardLane) => ReactNode;
}) {
  return <>
    {lanes.map((lane) => {
      const folded = collapsed.has(lane.projectId);
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
