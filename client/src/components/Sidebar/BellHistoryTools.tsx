/**
 * The tools above the bell's History (HUBBR-07): the filter chips with their
 * counts, and under «Automazioni e agenti» the hub's own split of its diary
 * (automations, agents, workflows, what you did, your computers and apps),
 * each with its count, as the hub's Diario page had them; then the search and
 * when the diary was read.
 */
import { Search } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { useMobile } from '../../hooks/useMobile';
import { DIARY_KIND_KEYS, HISTORY_FILTER_KEYS, type HistoryFilter } from '../../lib/bellHistory';
import type { DiaryKind } from '../../lib/hubSystem';
import { DANGER_TEXT } from '../../lib/popoverStyles';

const HISTORY_FILTER_LABEL: Record<HistoryFilter, string> = {
  all: 'bell.history.all',
  topics: 'bell.history.topics',
  hub: 'bell.history.hub',
  accounts: 'bell.history.accounts',
  problems: 'bell.history.problems',
};

function Chip({ on, onClick, label, count, alarm = false, testId, small = false }: {
  on: boolean;
  onClick: () => void;
  label: string;
  count: number;
  alarm?: boolean;
  testId: string;
  small?: boolean;
}) {
  const { isTouch } = useMobile();
  const size = isTouch ? 'h-9 text-prose' : small ? 'h-[22px] text-mini' : 'h-6 text-compact';
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-pressed={on}
      onClick={onClick}
      className={`flex items-center gap-[5px] whitespace-nowrap px-2 ${size} rounded-xs border transition-colors ${on ? 'border-primary/40 bg-primary/10 text-primary font-medium' : 'border-black/15 dark:border-white/20 text-app-text-secondary hover:bg-app-hover'}`}
      data-testid={testId}
      data-count={count}
    >
      {label}
      <span className={`tabular-nums ${alarm ? DANGER_TEXT : 'text-app-text-muted'}`}>{count}</span>
    </button>
  );
}

export function BellHistoryTools({ filter, onFilter, counts, kind, onKind, kindCounts, query, onQuery, fresh }: {
  filter: HistoryFilter;
  onFilter: (f: HistoryFilter) => void;
  counts: Record<HistoryFilter, number>;
  kind: DiaryKind | null;
  onKind: (k: DiaryKind | null) => void;
  kindCounts: Record<DiaryKind, number>;
  query: string;
  onQuery: (q: string) => void;
  /** How many events and when the diary was read, once it was. */
  fresh: string | null;
}) {
  const tr = useT();
  const { isTouch } = useMobile();
  return (
    <div className="border-b border-app-border/60" data-testid="bell-history-tools">
      <div className="flex gap-1 px-3 pt-1.5 overflow-x-auto" style={{ scrollbarWidth: 'none' }} role="group" aria-label={tr('bell.history.filter')} data-testid="bell-history-filter">
        {HISTORY_FILTER_KEYS.map((key) => (
          <Chip
            key={key}
            on={filter === key}
            onClick={() => { onFilter(key); onKind(null); }}
            label={tr(HISTORY_FILTER_LABEL[key])}
            count={counts[key]}
            alarm={key === 'problems' && counts.problems > 0}
            testId={`bell-history-${key}`}
          />
        ))}
      </div>
      {filter === 'hub' && (
        <div className="flex gap-1 px-3 pt-1 overflow-x-auto" style={{ scrollbarWidth: 'none' }} role="group" aria-label={tr('bell.history.kind')} data-testid="bell-history-kinds">
          {DIARY_KIND_KEYS.map((k) => (
            <Chip
              key={k}
              small
              on={kind === k}
              onClick={() => onKind(kind === k ? null : k)}
              label={tr(`bell.history.kind.${k}`)}
              count={kindCounts[k]}
              testId={`bell-history-kind-${k}`}
            />
          ))}
        </div>
      )}
      <label className={`flex items-center gap-1.5 mx-3 my-1.5 px-2 rounded-xs border border-black/15 dark:border-white/20 focus-within:border-primary/60 ${isTouch ? 'h-9' : 'h-6'}`}>
        <Search size={12} className="flex-shrink-0 text-app-text-muted" aria-hidden="true" />
        <input
          type="search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder={tr('bell.history.search')}
          aria-label={tr('bell.history.search')}
          className={`min-w-0 flex-1 bg-transparent outline-none text-app-text placeholder:text-app-text-muted ${isTouch ? 'text-prose' : 'text-compact'}`}
          data-testid="bell-history-search"
        />
        {fresh !== null && <span className="flex-shrink-0 text-mini text-app-text-muted tabular-nums" data-testid="bell-history-fresh">{fresh}</span>}
      </label>
    </div>
  );
}
export const __knipBlindspotProbe = 1; // KNIP-BLINDSPOT-PROBE — sonda temporanea, se la vedi committata cancellala
