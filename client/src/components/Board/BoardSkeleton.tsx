/**
 * The board while it is not there yet: the lazy chunk on its way (`LazyPane
 * kind="board"`) and then the first read (`KanbanBoardPane` with `loading`).
 *
 * The fluidity audit (panes:F7) measured a 16 px ring centred in an empty pane
 * for 120-300 ms, then the whole board in one commit. This draws the shape that
 * is coming instead: the toolbar strip and the five columns, with the SAME row
 * and column classes the board uses (`boardGeometry.ts`), so the real columns
 * land exactly where their placeholders stood and the board's own `reveal-in`
 * fade is the only change on screen.
 *
 * Kept free of anything heavy: it is in the main bundle, rendered before the
 * board chunk exists.
 */
import { TASK_STATUSES } from '../../lib/board';
import { COLUMN_FRAME, COLUMNS_ROW_GRID, COLUMNS_ROW_LIST, columnWidthClass, readBoardLayout, type BoardLayout } from './boardGeometry';

/** The theme-agnostic lift used by every skeleton bar (see `Shared/Skeleton`). */
const BAR = 'rounded bg-black/10 dark:bg-white/10';

/** Placeholder cards per column, in board order: a plausible, fixed shape. */
const CARDS_PER_COLUMN = [2, 3, 2, 2, 3];
/** Title widths (%), cycled so the placeholders do not look stamped. */
const TITLE_WIDTHS = [78, 62, 86, 70, 54];

export function BoardSkeleton({ layout }: { layout?: BoardLayout }) {
  const view = layout ?? readBoardLayout();
  return (
    <div data-testid="board-skeleton" aria-hidden="true" className="relative flex h-full flex-col overflow-hidden">
      {/* The toolbar row: same padding as `board-toolbar`, and its controls are
          as tall as `TOOLBAR_CONTROL_H` (24 px with a mouse, 44 under a finger),
          so the strip is 36 or 52 px like the real one and the columns do not
          jump down when the board replaces it on a phone. */}
      <div className="flex shrink-0 items-center gap-1 px-2 py-1.5 coarse:py-1 sm:px-3">
        <div className={`h-6 w-60 coarse:h-11 ${BAR} animate-pulse`} />
        <div className={`h-6 w-24 coarse:h-11 ${BAR} animate-pulse`} />
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1 flex-col">
          <div className={view === 'list' ? COLUMNS_ROW_LIST : COLUMNS_ROW_GRID}>
            {TASK_STATUSES.map((status, i) => (
              <div
                key={status}
                data-testid={`board-skeleton-column-${status}`}
                className={`${COLUMN_FRAME} ${columnWidthClass(view, status === 'review', status === 'review')} ${view === 'list' ? '' : 'shrink-0'}`}
              >
                {/* Header: `px-3 py-2` around a 16 px line, as in `Column`. */}
                <div className="flex items-center justify-between px-3 py-2">
                  <div className={`h-4 w-24 ${BAR} animate-pulse`} />
                  <div className={`h-4 w-5 ${BAR} animate-pulse`} />
                </div>
                <div className="flex-1 space-y-2 px-2 pt-1.5">
                  {Array.from({ length: CARDS_PER_COLUMN[i % CARDS_PER_COLUMN.length] }).map((_, k) => (
                    <div key={k} className="rounded-md border border-app-border p-2.5 animate-pulse">
                      <div className={`h-2.5 w-16 ${BAR}`} />
                      <div className={`mt-2 h-3.5 ${BAR}`} style={{ width: `${TITLE_WIDTHS[(i + k) % TITLE_WIDTHS.length]}%` }} />
                      <div className={`mt-3 h-2.5 w-10 ${BAR} ml-auto`} />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
