import type { HistoryRange, HistoryRowKind } from '../../lib/historyRows';
import { useT } from '../../hooks/useT';

/**
 * The two filters on top of the full history (HISTORY-03): what kind of row,
 * and which calendar day.
 *
 * Controlled and stateless: the values live in `CommandPalette`, which resets
 * them together with the query every time the panel opens, and moves the focus
 * back to the search field after each change, where the arrow keys and Enter
 * live.
 *
 * The shape is the mode switch of `Project/FileSearch.tsx` (a bordered
 * `role="group"`, `aria-pressed`, the active button in `text-primary
 * bg-primary/10`), so no colour or token is new here. Under 768 px the two
 * groups stack, one per row, and every button is a 44 px `flex-1` target: three
 * buttons in 343 px are 114 px each, four are 85 px, and the longest labels fit.
 */
export interface HistoryFiltersValue {
  /** `undefined` is the first button of the group: both sources. */
  kind: HistoryRowKind | undefined;
  range: HistoryRange;
}

const KINDS: { value: HistoryRowKind | undefined; id: string; label: string }[] = [
  { value: undefined, id: 'all', label: 'palette.historyKind.all' },
  { value: 'tab', id: 'tab', label: 'palette.historyKind.tab' },
  { value: 'page', id: 'page', label: 'palette.historyKind.page' },
];

const RANGES: { value: HistoryRange; label: string }[] = [
  { value: 'all', label: 'palette.historyRange.all' },
  { value: 'today', label: 'palette.historyRange.today' },
  { value: 'yesterday', label: 'palette.historyRange.yesterday' },
  { value: 'older', label: 'palette.historyRange.older' },
];

export function HistoryFilters({ kind, range, isMobile, onChange }: HistoryFiltersValue & {
  isMobile: boolean;
  onChange: (next: HistoryFiltersValue) => void;
}) {
  const t = useT();
  const group = `flex items-center rounded border border-app-spinner overflow-hidden ${isMobile ? 'w-full' : 'flex-shrink-0'}`;
  const button = (pressed: boolean) =>
    `${isMobile ? 'flex-1 h-11 px-1 text-prose justify-center' : 'px-1.5 py-0.5 text-mini'} flex items-center whitespace-nowrap ${
      pressed ? 'text-primary bg-primary/10' : 'text-app-text-muted'
    }`;
  return (
    <div
      data-testid="history-filters"
      className={`px-4 py-2 border-b border-app-border flex-shrink-0 flex ${isMobile ? 'flex-col gap-2' : 'items-center gap-2'}`}
    >
      <div className={group} role="group" aria-label={t('palette.historyKindGroup')}>
        {KINDS.map((k) => (
          <button
            key={k.id}
            type="button"
            data-testid={`history-filter-kind-${k.id}`}
            aria-pressed={kind === k.value}
            onClick={() => onChange({ kind: k.value, range })}
            className={button(kind === k.value)}
          >
            {t(k.label)}
          </button>
        ))}
      </div>
      <div className={group} role="group" aria-label={t('palette.historyRangeGroup')}>
        {RANGES.map((r) => (
          <button
            key={r.value}
            type="button"
            data-testid={`history-filter-range-${r.value}`}
            aria-pressed={range === r.value}
            onClick={() => onChange({ kind, range: r.value })}
            className={button(range === r.value)}
          >
            {t(r.label)}
          </button>
        ))}
      </div>
    </div>
  );
}
