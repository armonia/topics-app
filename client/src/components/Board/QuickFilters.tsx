import { useT } from '../../hooks/useT';
import type { BoardTask } from '../../lib/board';
import { QUICK_FILTERS, type BoardFilters, type QuickFilter } from './constants';
import { taskMatchesFilters, taskMatchesQuick } from './taskFilter';

/**
 * One-click filters over the board, each with the count of cards it would show.
 * They compose with every other filter and with every view (columns, list,
 * Plan): the filter lives in `BoardFilters`, the view only draws the result.
 * A count ignores the chip's own state but honours the rest, so it says what a
 * click would leave on screen.
 */
export function QuickFilters({ filters, onFiltersChange, tasks }: {
  filters: BoardFilters;
  onFiltersChange: (next: BoardFilters) => void;
  tasks: readonly BoardTask[];
}) {
  const tr = useT();
  const base = tasks.filter((t) => taskMatchesFilters(t, { ...filters, quick: undefined }));
  const active = filters.quick ?? [];
  const toggle = (q: QuickFilter) => {
    const next = active.includes(q) ? active.filter((x) => x !== q) : [...active, q];
    onFiltersChange({ ...filters, quick: next });
  };
  return (
    <div role="group" aria-label={tr('board.quick.label')} data-testid="board-quick-filters"
      className="flex shrink-0 items-center gap-1.5 overflow-x-auto px-2 pb-1.5">
      {QUICK_FILTERS.map((q) => {
        const on = active.includes(q);
        const count = base.filter((t) => taskMatchesQuick(t, q)).length;
        return (
          <button key={q} type="button" data-testid={`board-quick-${q}`} aria-pressed={on} onClick={() => toggle(q)}
            className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-compact leading-4 coarse:py-2 ${
              on ? 'border-primary bg-primary/15 text-app-text' : 'border-app-border text-app-text-secondary hover:bg-white/5'
            }`}>
            {tr(`board.quick.${q}`)}
            <span data-testid={`board-quick-count-${q}`} className="tabular-nums text-app-text-muted">{count}</span>
          </button>
        );
      })}
    </div>
  );
}
