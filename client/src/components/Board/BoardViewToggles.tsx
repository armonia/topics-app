/**
 * The board's view choices beside the list/kanban toggle, and the header of a
 * project lane (`boardLanes.ts`): grouping by project (cross-project board
 * only) and the cards' density, the same kind of toggle as the layout.
 */
import { ListCollapse, Rows3 } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { ProjectFavicon } from '../Shared/ProjectFavicon';
import { TOOLBAR_CONTROL_H, TOOLBAR_ICON_W } from './constants';
import type { BoardGroupBy, CardDensity } from './boardGeometry';

const toggleCls = (on: boolean) => `grid ${TOOLBAR_CONTROL_H} ${TOOLBAR_ICON_W} shrink-0 place-items-center rounded ${on ? 'bg-white/15 text-primary' : 'text-app-text-secondary hover:bg-white/5'}`;

export function BoardViewToggles({ grouping, groupBy, onGroupBy, density, onDensity }: {
  /** Whether grouping is offered here: the cross-project board, outside the Plan. */
  grouping: boolean;
  groupBy: BoardGroupBy; onGroupBy: (next: BoardGroupBy) => void;
  density: CardDensity; onDensity: (next: CardDensity) => void;
}) {
  const tr = useT();
  const grouped = groupBy === 'project';
  const compact = density === 'compact';
  const groupLabel = tr(grouped ? 'board.toolbar.groupBy.none' : 'board.toolbar.groupBy.project');
  const densityLabel = tr(compact ? 'board.toolbar.density.full' : 'board.toolbar.density.compact');
  return (
    <>
      {grouping && (
        <button type="button" data-testid="board-group-toggle" aria-pressed={grouped} onClick={() => onGroupBy(grouped ? 'none' : 'project')}
          className={toggleCls(grouped)} title={groupLabel} aria-label={groupLabel}
        ><Rows3 className="h-3.5 w-3.5" /></button>
      )}
      <button type="button" data-testid="board-density-toggle" aria-pressed={compact} onClick={() => onDensity(compact ? 'full' : 'compact')}
        className={toggleCls(compact)} title={densityLabel} aria-label={densityLabel}
      ><ListCollapse className="h-3.5 w-3.5" /></button>
    </>
  );
}

/**
 * A project lane's header: the project as the Plan's tiles name it (favicon
 * and name) and how many of its cards are on the board, the running and
 * waiting ones apart.
 */
export function LaneHeader({ name, path, total, active }: { name: string; path?: string; total: number; active: number }) {
  const tr = useT();
  return (
    <div className="sticky left-0 flex w-fit max-w-full items-center gap-2 px-1" data-testid="board-lane-header">
      {path ? <ProjectFavicon path={path} size={16} className="shrink-0" /> : null}
      <span className="truncate text-compact font-semibold text-app-text-heading">{name}</span>
      <span className="shrink-0 rounded bg-white/10 px-1.5 text-compact leading-4 text-app-text-secondary tabular-nums" data-testid="board-lane-count">{total}</span>
      {active > 0 && <span className="shrink-0 text-mini text-app-text-secondary tabular-nums">{tr('board.lanes.active', { n: active })}</span>}
    </div>
  );
}
