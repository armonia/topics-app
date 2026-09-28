/**
 * ONE HISTORY, AND ONLY ONE.
 *
 * Until yesterday the app kept two of them, and they looked nothing alike: the
 * CLOSED TABS (an undo stack, visible only inside ⌘K) and the PAGES visited by
 * the browser (a list of strings per topic, inside a dropdown of the toolbar).
 * Same human question ("where was I, take me back there"): two lists, two
 * gestures, two places to go looking.
 *
 * Here the two sources become ROWS of the same type, ordered by time. The
 * function is pure and knows nothing about React: it takes the two snapshots
 * and hands back the list. Whoever uses it decides what a click does, because
 * the action is different (reopening a tab is not opening a URL), but the row
 * is the same, and the surfaces that show it can no longer drift apart.
 */
import type { PaneType } from '../types';
import type { ClosedTabRecord } from '../state/pane/adapters/closedTabRecord';
import type { PageVisit } from '../state/browserSiteHistory';
import { getProjectLabel } from './buildSidebarItems';
import { prettyUrl } from './browserNavUrl';

export type HistoryRowKind = 'tab' | 'page';

export interface HistoryRow {
  /** List key, unique across the two sources. */
  id: string;
  kind: HistoryRowKind;
  /** What is read at full size: the name of the tab, or the title of the page
   *  when it has one (a page with no title shows up under its own URL). */
  label: string;
  /** The line underneath: the URL for a page, the project or the folder for
   *  a tab. It is allowed to be empty. */
  detail: string;
  /** Epoch ms: close time for a tab, visit time for a page. */
  at: number;
  /** The URL, when the row has one (pages and browser tabs). */
  url?: string;
  favicon?: string;
  /** The pane type, for the icon: only on rows that come from a tab. */
  paneType?: PaneType;
  /** The original record, the thing that actually reopens the tab. */
  record?: ClosedTabRecord;
}

/**
 * Which calendar day a row falls on, as the filter bar names it. `'all'` is
 * the absence of a filter, never the answer for a row.
 */
export type HistoryRange = 'all' | 'today' | 'yesterday' | 'older';

/**
 * The day an instant belongs to, seen from `now`, in the local calendar.
 *
 * The two midnights come from the Date constructor with the day moved by one,
 * never from `now - 86_400_000`: in Europe/Rome 25/10/2026 lasts 25 hours, and
 * the subtraction would put the start of yesterday one hour late, sending a
 * page seen at 00:30 of that day into `'older'`.
 *
 * An instant ahead of `now` is `'today'`: `closedStack` is synced across
 * devices (CMD-05), so a `closedAt` can come from another machine's clock, and
 * a row from a clock a few minutes ahead must not vanish from every filter.
 */
export function historyRangeOf(at: number, now: number): Exclude<HistoryRange, 'all'> {
  const d = new Date(now);
  const startToday = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  if (at >= startToday) return 'today';
  const startYesterday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1).getTime();
  return at >= startYesterday ? 'yesterday' : 'older';
}

/** The text the search runs against. Lowercased once, right here. */
function haystack(row: HistoryRow): string {
  return `${row.label} ${row.detail} ${row.url ?? ''}`.toLowerCase();
}

/**
 * The two sources in a single list, newest first.
 *
 * `query` filters on name, detail and URL, one word at a time, and all of them
 * have to appear: searching "github pr" must find the page even when the two
 * words sit in two fields. Every surface that lists the history (the palette
 * in both of its scopes, the preview in the user menu) gets its rows from
 * here, so this is the only search rule the history has. The age a surface
 * prints next to a row is not in the haystack: "fa" would match every row.
 *
 * The steps run in a fixed order: type, day, search, sort, cap. `kind` skips a
 * whole source before its rows are built; the cap comes last, because a
 * filter applied after it would only see the rows the cap let through.
 */
export function buildHistoryRows(input: {
  closedTabs?: readonly ClosedTabRecord[];
  pages?: readonly PageVisit[];
  query?: string;
  /** Only one of the two sources. Absent means both. */
  kind?: HistoryRowKind;
  /** Only one calendar day, see `historyRangeOf`. Absent means `'all'`. */
  range?: HistoryRange;
  /** Epoch ms the days are counted from. Defaults to `Date.now()`. */
  now?: number;
  limit?: number;
}): HistoryRow[] {
  const rows: HistoryRow[] = [];

  for (const closed of input.kind === 'page' ? [] : input.closedTabs ?? []) {
    const url = closed.pane.type === 'browser' ? closed.pane.url : undefined;
    const projectLabel = closed.projectPath ? getProjectLabel(closed.projectPath) : '';
    const cwd = closed.terminal?.cwd ? getProjectLabel(closed.terminal.cwd) : '';
    rows.push({
      id: `tab:${closed.id}`,
      kind: 'tab',
      label: closed.pane.title || (url ? prettyUrl(url) : '') || closed.pane.type,
      detail: [projectLabel, cwd && cwd !== projectLabel ? cwd : ''].filter(Boolean).join(' · '),
      at: closed.closedAt,
      url,
      paneType: closed.pane.type,
      record: closed,
    });
  }

  for (const p of input.kind === 'tab' ? [] : input.pages ?? []) {
    rows.push({
      id: `page:${p.url}`,
      kind: 'page',
      label: p.title || prettyUrl(p.url),
      detail: prettyUrl(p.url),
      at: p.at,
      url: p.url,
      favicon: p.favicon || undefined,
    });
  }

  const range = input.range ?? 'all';
  const now = input.now ?? Date.now();
  const inRange = range === 'all' ? rows : rows.filter((r) => historyRangeOf(r.at, now) === range);

  const terms = (input.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = terms.length === 0
    ? inRange
    : inRange.filter((r) => {
        const hay = haystack(r);
        return terms.every((t) => hay.includes(t));
      });

  filtered.sort((a, b) => b.at - a.at);
  return typeof input.limit === 'number' ? filtered.slice(0, Math.max(0, input.limit)) : filtered;
}
