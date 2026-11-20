/**
 * The toolbar controls that choose how the board is read: the VIEW (kanban,
 * list, cards), the grouping («group by» and «then by») and whether the Done
 * column is shown. Out of `KanbanBoardPane` so the pane keeps its size budget.
 */
import { CheckCircle2, LayoutGrid, List, SquareKanban } from 'lucide-react';
import { useT } from '../../hooks/useT';
import type { BoardGroupBy } from './boardGeometry';
import { groupKeysFor } from './boardGrouping';
import { TOOLBAR_CONTROL_H, TOOLBAR_ICON_W } from './constants';
import { Select } from '../Shared/Select';
import { DETAIL_LEVELS, type DetailLevel } from './detailLevel';

const VIEW_ICON = { grid: SquareKanban, list: List, plan: LayoutGrid } as const;

/** ONE selector with the three views. Arrow keys move along it (a radio group). */
export function ViewSelector({ value, onChange }: { value: DetailLevel; onChange: (next: DetailLevel) => void }) {
  const tr = useT();
  return (
    <div
      role="radiogroup" data-testid="board-view-selector" aria-label={tr('board.view.label')}
      className="mx-1 flex shrink-0 items-center gap-px rounded bg-white/5"
      onKeyDown={(e) => {
        const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
        if (!step) return;
        e.preventDefault();
        const next = DETAIL_LEVELS[(DETAIL_LEVELS.indexOf(value) + step + DETAIL_LEVELS.length) % DETAIL_LEVELS.length];
        onChange(next);
      }}
    >
      {DETAIL_LEVELS.map((level) => {
        const Icon = VIEW_ICON[level];
        const on = level === value;
        return (
          <button
            key={level} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1}
            data-testid={`board-view-${level}`} title={tr(`board.view.${level}`)}
            onClick={() => onChange(level)}
            className={`flex ${TOOLBAR_CONTROL_H} items-center gap-1 rounded px-1.5 text-compact leading-4 coarse:min-w-11 coarse:justify-center ${on ? 'bg-white/15 text-app-text' : 'text-app-text-secondary hover:bg-white/5'}`}
          ><Icon className="h-3.5 w-3.5" /><span className="hidden lg:inline">{tr(`board.view.${level}`)}</span></button>
        );
      })}
    </div>
  );
}

// h-6 like every other control of the bar; the shared Select's own vertical padding is cancelled.
const selectClass = `${TOOLBAR_CONTROL_H} min-w-0 max-w-[8rem] shrink !py-0 text-compact`;

/** «Group by» and, once the first is chosen, «then by»: two levels at most. */
export function GroupSelectors({ view, hasProjects, groupBy, thenBy, onGroupBy, onThenBy }: {
  view: DetailLevel; hasProjects: boolean;
  groupBy: BoardGroupBy; thenBy: BoardGroupBy;
  onGroupBy: (next: BoardGroupBy) => void; onThenBy: (next: BoardGroupBy) => void;
}) {
  const tr = useT();
  const keys = groupKeysFor(view, hasProjects);
  const first = keys.includes(groupBy) ? groupBy : 'none';
  const second = first !== 'none' && thenBy !== first && keys.includes(thenBy) ? thenBy : 'none';
  const optionsFor = (skip: BoardGroupBy | null) => keys.filter((k) => k !== skip).map((k) => ({
    value: k, label: k === 'none' ? tr('board.groupBy.none') : tr(`board.groupBy.${k}`),
  }));
  // «None» shows the caption of the control, not a value: an empty control reads as «Group by».
  return <>
    <Select<BoardGroupBy>
      testId="board-group-by" ariaLabel={tr('board.groupBy.label')}
      value={(first === 'none' ? '' : first) as BoardGroupBy} options={optionsFor(null)} onChange={onGroupBy}
      className={selectClass} placeholder={tr('board.groupBy.label')}
    />
    {first !== 'none' && (
      <Select<BoardGroupBy>
        testId="board-then-by" ariaLabel={tr('board.thenBy.label')}
        value={(second === 'none' ? '' : second) as BoardGroupBy} options={optionsFor(first)} onChange={onThenBy}
        className={selectClass} placeholder={tr('board.thenBy.label')}
      />
    )}
  </>;
}

export function DoneToggle({ showDone, onShowDone }: { showDone: boolean; onShowDone: (next: (v: boolean) => boolean) => void }) {
  const tr = useT();
  return (
    <button
      type="button" data-testid="board-done-toggle" aria-pressed={showDone}
      onClick={() => onShowDone((v) => !v)}
      className={`grid ${TOOLBAR_CONTROL_H} ${TOOLBAR_ICON_W} shrink-0 place-items-center rounded ${showDone ? 'bg-white/15 text-primary' : 'text-app-text-secondary hover:bg-white/5'}`}
      title={tr(showDone ? 'board.toolbar.done.hide' : 'board.toolbar.done.show')}
    ><CheckCircle2 className="h-3.5 w-3.5" /></button>
  );
}
