/**
 * The open Git section while its panel is on the way.
 *
 * Opening the section used to grow it twice (fluidity audit panes:F11): first
 * to its 160 px floor around a bare header with a 10 px spinner, then, 300 ms
 * later, by another 237 px when the panel and its rows arrived. This draws the
 * rows that are coming, with the classes of the real compact panel (commit row,
 * one group header, one row per changed file), so the section opens ONCE to
 * about the height it is going to keep.
 *
 * Light on purpose: it is the Suspense fallback of the lazy `GitChanges`.
 */
import { TREE_ROW_CARD } from '../../lib/selectionStyles';

const BAR = 'rounded bg-black/10 dark:bg-white/10';
const NO_BREAK_SPACE = ' ';
/** The section caps its height anyway; past this the rows would be clipped. */
const MAX_ROWS = 30;
const PATH_WIDTHS = [62, 48, 74, 55, 68, 42, 80, 58];

export function GitSectionSkeleton({ fileCount }: { fileCount: number }) {
  const rows = Math.min(Math.max(fileCount, 1), MAX_ROWS);
  return (
    <div data-testid="git-section-skeleton" aria-hidden="true" className="flex flex-col min-h-0 animate-pulse">
      {/* The commit row: textarea (16 px line + 2 px padding + border) and the 22 px button. */}
      <div className="border-t border-app-border mx-1.5 px-2 py-1 flex items-end gap-1 flex-shrink-0">
        <div className="flex-1 min-w-0 px-1.5 py-[2px] text-mini leading-[16px] border border-app-border-input rounded">{NO_BREAK_SPACE}</div>
        <div className={`w-9 h-[22px] ${BAR}`} />
      </div>
      {/* One group header ("Changes (n)"). */}
      <div className="flex items-center px-3 py-1">
        <span className="text-mini">{NO_BREAK_SPACE}</span>
        <div className={`h-2.5 w-20 ${BAR}`} />
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className={`flex items-center gap-1.5 ${TREE_ROW_CARD} px-2 py-[3px]`}>
            <div className={`w-3.5 h-3.5 flex-shrink-0 ${BAR}`} />
            <span className="text-mini">{NO_BREAK_SPACE}</span>
            <div className={`h-2.5 ${BAR}`} style={{ width: `${PATH_WIDTHS[i % PATH_WIDTHS.length]}%` }} />
          </div>
        ))}
      </div>
    </div>
  );
}
