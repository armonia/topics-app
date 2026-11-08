/**
 * THE BELL'S HISTORY (ATTN-09, HUBBR-07): the log of Topics, by day, read
 * only, with the hub's diary merged in by time (failed runs, agents,
 * workflows, what you said) and the Claude proxy's activity log (the hub's
 * Activity page: every event of the week, its hour, its severity). A filter
 * with counts (everything, Topics, automations and agents, Claude accounts,
 * problems), a search over the words of a line, and per day how many events
 * and how many failed. Moved out of `InboxPanel.tsx`, which sat at the
 * `check:bloat` ceiling.
 */
import { createElement, useState } from 'react';
import { Inbox as InboxIcon } from 'lucide-react';
import { historyRowIcon, historyTitle } from '../../lib/notify/historyGlyph';
import { useT } from '../../hooks/useT';
import { useMobile } from '../../hooks/useMobile';
import { useLoadOnReach } from '../../hooks/useLoadOnReach';
import { useAttentionRows } from '../../state/attention';
import { historyDayKey } from '../../lib/inboxModel';
import type { DiaryEntry, DiaryKind } from '../../lib/hubSystem';
import { proxyText, type ProxyEvent } from '../../lib/proxyEvents';
import {
  dayTally, diaryForFilter, diaryKindCounts, diaryMatches, historyCounts, proxyForFilter, proxyMatches, topicsMatches, type HistoryFilter,
} from '../../lib/bellHistory';
import { BellHistoryTools } from './BellHistoryTools';
import { openDeepLinkInApp } from '../../lib/deepLinkEntry';
import { DANGER_TEXT } from '../../lib/popoverStyles';
import { useSharedNow } from '../../state/useSharedNow';
import type { NotificationRow } from '../../../../shared/notification-log';
import { BellTime, DiaryRow, ProxyRow } from './BellRows';

type HistoryLine =
  | { at: number; key: string; row: NotificationRow }
  | { at: number; key: string; diary: DiaryEntry }
  | { at: number; key: string; proxy: ProxyEvent };

/**
 * The log, by day, read only, with the hub's diary and the proxy's events
 * merged in by time. A row whose subject is still lit keeps its dot. While
 * older rows of Topics are still to come, the hub's lines show only what is
 * newer than the last one loaded under «all», so an old run does not sit
 * above a page that has not arrived yet. `filter` is the panel's: an account
 * row of «Now» opens History on «Account Claude».
 */
export function History({ rows, diary, proxy, diaryReadAt, hubPresent, loading, hasMore, loadingMore, loadMore, onClose, filter, setFilter }: {
  rows: NotificationRow[];
  diary: DiaryEntry[];
  proxy: ProxyEvent[];
  diaryReadAt: number | null;
  hubPresent: boolean;
  loading: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  onClose: () => void;
  filter: HistoryFilter;
  setFilter: (f: HistoryFilter) => void;
}) {
  const tr = useT();
  const [kind, setKind] = useState<DiaryKind | null>(null);
  const [query, setQuery] = useState('');
  // Infinite scroll, within the hundred rows the panel keeps: the next page comes as its tail comes into view.
  const moreRef = useLoadOnReach(loadMore, { more: hasMore && rows.length < 100, loading: loadingMore, count: rows.length });
  const now = useSharedNow();
  const attention = useAttentionRows();
  const outcomeWord = (o: string) => tr(`bell.diary.outcome.${o}`);
  const loaded = rows.slice(0, 100);
  const oldestTopics = hasMore && loaded.length > 0 ? Date.parse(loaded[loaded.length - 1]!.createdAt) : Number.NEGATIVE_INFINITY;
  const searchedTopics = loaded.filter((r) => topicsMatches({ title: r.title, body: r.body ?? '' }, query));
  const searchedDiary = diary.filter((d) => diaryMatches(d, query, outcomeWord));
  const searchedProxy = proxy.filter((e) => proxyMatches([proxyText(e.text, tr), e.detail ? proxyText(e.detail, tr) : '', tr('proxy.who')].join(' '), query));
  const counts = historyCounts(searchedTopics.length, searchedDiary, searchedProxy);
  const topicsRows = filter === 'all' || filter === 'topics' ? searchedTopics : [];
  const diaryRows = diaryForFilter(searchedDiary, filter, kind).filter((d) => filter !== 'all' || d.at >= oldestTopics);
  const proxyRows = proxyForFilter(searchedProxy, filter).filter((e) => filter !== 'all' || e.at >= oldestTopics);
  const lines: HistoryLine[] = [
    ...topicsRows.map((row) => ({ at: Date.parse(row.createdAt), key: `n:${row.id}`, row })),
    ...diaryRows.map((d) => ({ at: d.at, key: d.id, diary: d })),
    ...proxyRows.map((e) => ({ at: e.at, key: e.id, proxy: e })),
  ].sort((a, b) => b.at - a.at);

  const fresh = diaryReadAt === null ? null : tr('bell.history.fresh', { n: diary.length + proxy.length, time: new Date(diaryReadAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }) });
  const chips = hubPresent && (
    <BellHistoryTools filter={filter} onFilter={setFilter} counts={counts} kind={kind} onKind={setKind} kindCounts={diaryKindCounts(searchedDiary)} query={query} onQuery={setQuery} fresh={fresh} />
  );

  if (lines.length === 0) {
    return (
      <>
        {chips}
        <div className="px-4 py-7 text-center" data-testid="inbox-history-empty">
          <InboxIcon size={18} className="mx-auto mb-2 text-app-text-muted" aria-hidden="true" />
          <div className="text-compact text-app-text-secondary">{loading ? tr('common.loading') : query.trim() ? tr('bell.history.noMatch') : tr('notifications.empty')}</div>
        </div>
      </>
    );
  }
  const days: { key: string; lines: HistoryLine[] }[] = [];
  for (const l of lines) {
    const key = historyDayKey(new Date(l.at).toISOString(), now);
    if (days.at(-1)?.key !== key) days.push({ key, lines: [] });
    days.at(-1)!.lines.push(l);
  }
  return (
    <div data-testid="inbox-history">
      {chips}
      {days.map((d) => (
        <section key={d.key} className="pb-1">
          <h3 className="flex items-baseline gap-1.5 px-3 pt-2 pb-0.5 text-mini font-semibold uppercase tracking-[.04em] text-app-text-muted" data-testid="bell-history-day">
            {d.key === 'today' ? tr('inbox.day.today') : d.key === 'yesterday' ? tr('inbox.day.yesterday') : new Date(`${d.key}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}
            <DayTally lines={d.lines} />
          </h3>
          <ul>
            {d.lines.map((l) => ('diary' in l
              ? <DiaryRow key={l.key} entry={l.diary} onNavigate={onClose} />
              : 'proxy' in l
                ? <ProxyRow key={l.key} event={l.proxy} />
                : <HistoryRow key={l.key} row={l.row} lit={!!l.row.groupKey && !!attention.get(l.row.groupKey)?.lit} onClose={onClose} />))}
          </ul>
        </section>
      ))}
      {(filter === 'all' || filter === 'topics') && hasMore && rows.length < 100 && (
        <button ref={moreRef} type="button" onClick={loadMore} disabled={loadingMore} className="w-full px-3 py-2 text-mini text-app-text-secondary hover:bg-app-hover transition-colors" data-testid="inbox-history-more">
          {loadingMore ? tr('notifications.loadingMore') : tr('notifications.loadMore')}
        </button>
      )}
    </div>
  );
}

/** «12 eventi · 3 falliti» beside the day's name. */
function DayTally({ lines }: { lines: HistoryLine[] }) {
  const tr = useT();
  const { events, failed } = dayTally(lines);
  return (
    <span className="normal-case tracking-normal font-normal tabular-nums" data-testid="bell-history-day-tally" data-events={events} data-failed={failed}>
      {events === 1 ? tr('bell.day.countOne') : tr('bell.day.count', { n: events })}
      {failed > 0 && <span className={DANGER_TEXT}>{' · '}{failed === 1 ? tr('bell.day.failedOne') : tr('bell.day.failed', { n: failed })}</span>}
    </span>
  );
}

function HistoryRow({ row, lit, onClose }: { row: NotificationRow; lit: boolean; onClose: () => void }) {
  const tr = useT();
  const { isMobile } = useMobile();
  const system = row.kind === 'system';
  const title = historyTitle(row.title);
  const at = Date.parse(row.createdAt);
  return (
    <li>
      <button
        type="button"
        data-inbox-row=""
        tabIndex={-1}
        disabled={!row.targetUrl}
        onClick={() => { if (row.targetUrl && openDeepLinkInApp(row.targetUrl)) onClose(); }}
        className={`w-full flex items-center gap-2.5 text-left enabled:hover:bg-app-hover focus-visible:bg-app-hover outline-none transition-colors disabled:cursor-default ${isMobile ? 'min-h-11 pl-3.5 pr-3 py-2' : 'min-h-10 pl-3 pr-2.5 py-1'}`}
        data-testid="inbox-history-row"
        data-lit={lit ? 'true' : undefined}
      >
        {createElement(historyRowIcon(row), { size: 15, className: 'self-start mt-[3px] flex-shrink-0 text-app-text-tertiary', 'aria-hidden': true })}
        <span className="min-w-0 flex-1">
          <span className={`block font-medium text-app-text truncate ${isMobile ? 'text-body-lg' : 'text-compact leading-4'}`}>{system ? tr('inbox.system') : title}</span>
          <span className={`flex items-center gap-[5px] text-app-text-secondary min-w-0 whitespace-nowrap ${isMobile ? 'text-prose' : 'text-compact leading-4'}`}>
            <span className="truncate">{system ? title : row.body}</span>
            {Number.isFinite(at) && <span className="flex-shrink-0 text-app-text-muted">·</span>}
            {Number.isFinite(at) && <BellTime at={at} className="text-app-text-muted" />}
          </span>
        </span>
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${lit ? 'bg-primary' : 'bg-transparent'}`} aria-hidden="true" />
      </button>
    </li>
  );
}
