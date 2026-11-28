/**
 * The toolbar controls that choose how the board is read: the VIEW (kanban,
 * list, cards), the grouping («group by» and «then by») and whether the Done
 * column is shown. Out of `KanbanBoardPane` so the pane keeps its size budget.
 */
import { AlignJustify, CheckCircle2, Columns3, Equal, List, RectangleVertical, SquareKanban, Table2, UsersRound, Workflow } from 'lucide-react';
import { useRef } from 'react';
import { useT } from '../../hooks/useT';
import { BOARD_DENSITIES, type BoardDensity, type BoardGroupBy } from './boardGeometry';
import { groupKeysFor } from './boardGrouping';
import { TOOLBAR_CONTROL_H, TOOLBAR_ICON_W } from './constants';
import { Select } from '../Shared/Select';
import { COLUMNS_MODES, type ColumnsMode } from './columnsMode';
import { DETAIL_LEVELS, type DetailLevel } from './detailLevel';
import { densityStopForDrag, densityStopForPress } from './densityStops';

const VIEW_ICON = { grid: SquareKanban, list: List, table: Table2, plan: UsersRound, workflow: Workflow } as const;

/** ONE selector with the five views, each with its name and a tooltip that says what it shows. Arrow keys move along it (a radio group). */
export function ViewSelector({ value, onChange }: { value: DetailLevel; onChange: (next: DetailLevel) => void }) {
  const tr = useT();
  return (
    <div
      role="radiogroup" data-testid="board-view-selector" aria-label={tr('board.view.label')}
      className="mx-0.5 flex shrink-0 items-center gap-px rounded bg-black/5 dark:bg-white/5"
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
            data-testid={`board-view-${level}`} title={tr(`board.view.${level}Title`)} aria-label={tr(`board.view.${level}`)}
            onClick={() => onChange(level)}
            className={`flex ${TOOLBAR_CONTROL_H} items-center gap-1 rounded px-1.5 text-compact leading-4 coarse:min-w-11 coarse:justify-center ${on ? 'bg-black/10 dark:bg-white/15 text-app-text' : 'text-app-text-secondary hover:bg-black/5 dark:hover:bg-white/5'}`}
          ><Icon className="h-3.5 w-3.5" aria-hidden="true" /><span className="hidden @7xl:inline">{tr(`board.view.${level}`)}</span></button>
        );
      })}
    </div>
  );
}

/**
 * HOW MUCH OF EACH CARD, as a slider with three stops: the title alone, the
 * compact card, the whole card. Few lines on the left, many on the right, like
 * a zoom. A slider (not three buttons) because the stops are an order.
 *
 * ONE target: a press anywhere on it picks the nearest stop, and the two
 * glyphs at the ends step down or up. Holding the press and moving DRAGS the
 * knob along the track (mouse, pen or finger): the pointer is captured, so the
 * drag keeps following outside the 40px track, and past an end it rests on
 * that end instead of stepping again. The dots and glyphs are drawing, not
 * buttons: three 16px buttons side by side cannot each be a 44px target under a
 * finger (KANBAN-MOBILE-02), while the whole slider is.
 */
export function DensitySlider({ value, onChange }: { value: BoardDensity; onChange: (next: BoardDensity) => void }) {
  const tr = useT();
  const track = useRef<HTMLSpanElement>(null);
  // The stop the knob sits on during a drag: `at` comes from the last render,
  // and a fast drag fires several moves before the next one.
  const dragAt = useRef<number | null>(null);
  const at = BOARD_DENSITIES.indexOf(value);
  const last = BOARD_DENSITIES.length - 1;
  const go = (i: number) => onChange(BOARD_DENSITIES[Math.max(0, Math.min(last, i))]!);
  const ratioAt = (clientX: number): number | null => {
    const r = track.current?.getBoundingClientRect();
    return !r || r.width === 0 ? null : (clientX - r.left) / r.width;
  };
  const press = (clientX: number) => {
    const ratio = ratioAt(clientX);
    if (ratio === null) return;
    const next = densityStopForPress(ratio, at, last);
    dragAt.current = next;
    go(next);
  };
  const drag = (clientX: number) => {
    const ratio = ratioAt(clientX);
    if (ratio === null || dragAt.current === null) return;
    const next = densityStopForDrag(ratio, last);
    if (next === dragAt.current) return;
    dragAt.current = next;
    go(next);
  };
  return (
    <div
      role="slider" tabIndex={0} data-testid="board-density" data-density={value}
      aria-label={tr('board.density.label')} aria-valuemin={0} aria-valuemax={last} aria-valuenow={at}
      aria-valuetext={tr(`board.density.${value}`)} title={`${tr('board.density.label')}: ${tr(`board.density.${value}`)}`}
      onKeyDown={(e) => {
        const step = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
        if (e.key === 'Home') { e.preventDefault(); go(0); return; }
        if (e.key === 'End') { e.preventDefault(); go(last); return; }
        if (!step) return;
        e.preventDefault();
        go(at + step);
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        press(e.clientX);
      }}
      onPointerMove={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) drag(e.clientX); }}
      onPointerUp={() => { dragAt.current = null; }}
      onPointerCancel={() => { dragAt.current = null; }}
      // `touch-none`: a finger moving on the knob drags it instead of scrolling the toolbar.
      className={`mx-0.5 flex ${TOOLBAR_CONTROL_H} shrink-0 cursor-pointer touch-none select-none items-center gap-1 rounded px-1 text-app-text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary coarse:min-h-11`}
    >
      <span aria-hidden="true" title={tr('board.density.less')} className="grid place-items-center hover:text-app-text"><Equal className="h-3.5 w-3.5" /></span>
      <span ref={track} className="relative flex h-4 w-10 items-center">
        <span className="absolute inset-x-0 h-0.5 rounded-full bg-app-border" />
        <span className="absolute left-0 h-0.5 rounded-full bg-primary" style={{ width: `${(at / last) * 100}%` }} />
        {BOARD_DENSITIES.map((level, i) => (
          <span
            key={level} aria-hidden="true" data-testid={`board-density-${level}`} title={tr(`board.density.${level}`)}
            className="absolute grid h-4 w-4 -translate-x-1/2 place-items-center" style={{ left: `${(i / last) * 100}%` }}
          ><span className={i === at ? 'h-3 w-3 rounded-full bg-primary shadow ring-2 ring-surface' : `h-1.5 w-1.5 rounded-full ${i < at ? 'bg-primary' : 'bg-app-border-light'}`} /></span>
        ))}
      </span>
      <span aria-hidden="true" title={tr('board.density.more')} className="grid place-items-center hover:text-app-text"><AlignJustify className="h-3.5 w-3.5" /></span>
    </div>
  );
}

// h-6 like every other control of the bar; the shared Select's own vertical padding is cancelled.
const selectClass = `${TOOLBAR_CONTROL_H} min-w-0 max-w-32 shrink !py-0 text-compact`;

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
      className={`grid ${TOOLBAR_CONTROL_H} ${TOOLBAR_ICON_W} shrink-0 place-items-center rounded ${showDone ? 'bg-black/10 dark:bg-white/15 text-primary' : 'text-app-text-secondary hover:bg-black/5 dark:hover:bg-white/5'}`}
      title={tr(showDone ? 'board.toolbar.done.hide' : 'board.toolbar.done.show')}
    ><CheckCircle2 className="h-3.5 w-3.5" /></button>
  );
}

const COLUMNS_ICON = { split: Columns3, single: RectangleVertical } as const;

/** «Columns»: the status columns side by side, or ONE column holding every status. A toggle that shows the mode it leads to. */
export function ColumnsToggle({ value, onChange }: { value: ColumnsMode; onChange: (next: ColumnsMode) => void }) {
  const tr = useT();
  const next = COLUMNS_MODES[(COLUMNS_MODES.indexOf(value) + 1) % COLUMNS_MODES.length]!;
  const Icon = COLUMNS_ICON[value];
  return (
    <button
      type="button" data-testid="board-columns-toggle" data-columns={value} aria-pressed={value === 'single'}
      aria-label={tr('board.columns.label')} title={`${tr('board.columns.label')}: ${tr(`board.columns.${value}`)} (${tr(`board.columns.${next}Title`)})`}
      onClick={() => onChange(next)}
      className={`grid ${TOOLBAR_CONTROL_H} ${TOOLBAR_ICON_W} shrink-0 place-items-center rounded ${value === 'single' ? 'bg-black/10 dark:bg-white/15 text-primary' : 'text-app-text-secondary hover:bg-black/5 dark:hover:bg-white/5'}`}
    ><Icon className="h-3.5 w-3.5" aria-hidden="true" /></button>
  );
}
