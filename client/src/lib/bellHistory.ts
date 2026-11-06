/**
 * The bell's History, as the hub's diary page read it (HUBBR-07): a filter
 * with its counts, a search over the words of a line, and per day how many
 * events and how many failed. The Claude proxy's log (the hub's Activity
 * page) has a filter of its own, «Account Claude»; its problems (an expired
 * token, every account exhausted) count among the problems. Pure: the panel
 * passes the lines it holds.
 */
import type { DiaryEntry, DiaryKind } from './hubSystem';
import type { ProxyEvent } from './proxyEvents';

export type HistoryFilter = 'all' | 'topics' | 'hub' | 'accounts' | 'problems';

export const HISTORY_FILTER_KEYS: readonly HistoryFilter[] = ['all', 'topics', 'hub', 'accounts', 'problems'];

/** A line of Topics' own log, the words the search reads. */
export interface TopicsLine {
  title: string;
  body: string;
}

/** A failure that is the person's to know: a run that failed or did not deliver, not their own apps' runs. */
export function isProblem(d: DiaryEntry): boolean {
  return (d.outcome === 'error' || d.outcome === 'undelivered') && d.kind !== 'app';
}

/** The words a search runs on, lowered: each of «brief, Codex, failed» must be found. */
function words(query: string): string[] {
  return query.toLowerCase().split(/[\s,]+/).filter(Boolean);
}

const matches = (haystack: string, ws: string[]) => ws.every((w) => haystack.includes(w));

export function diaryMatches(d: DiaryEntry, query: string, outcomeWord: (o: string) => string = (o) => o): boolean {
  const ws = words(query);
  if (ws.length === 0) return true;
  return matches([d.title, d.what, d.who, d.outcome ? outcomeWord(d.outcome) : ''].join(' ').toLowerCase(), ws);
}

/** A proxy event against the search: its sentence and detail, in the panel's words. */
export function proxyMatches(text: string, query: string): boolean {
  const ws = words(query);
  return ws.length === 0 || matches(text.toLowerCase(), ws);
}

export function topicsMatches(t: TopicsLine, query: string): boolean {
  const ws = words(query);
  return ws.length === 0 || matches(`${t.title} ${t.body}`.toLowerCase(), ws);
}

/**
 * The hub's own split of its diary, under «Automazioni e agenti»: automations,
 * agents, workflows, what you did, your own computers and apps. In the hub's
 * order; null is all of them.
 */
export const DIARY_KIND_KEYS: readonly DiaryKind[] = ['auto', 'agente', 'workflow', 'tu', 'app']; // allow-italian: the hub's wire values

/** Which diary lines a filter keeps; `kind` narrows «Automazioni e agenti» to one of the hub's kinds. */
export function diaryForFilter(rows: readonly DiaryEntry[], filter: HistoryFilter, kind: DiaryKind | null = null): DiaryEntry[] {
  if (filter === 'topics' || filter === 'accounts') return [];
  if (filter === 'problems') return rows.filter(isProblem);
  if (filter === 'hub' && kind !== null) return rows.filter((d) => d.kind === kind);
  return [...rows];
}

/** How many lines of each kind, over what the search leaves. */
export function diaryKindCounts(diary: readonly DiaryEntry[]): Record<DiaryKind, number> {
  const counts: Record<DiaryKind, number> = { auto: 0, agente: 0, workflow: 0, tu: 0, app: 0 }; // allow-italian: the hub's wire values
  for (const d of diary) counts[d.kind] += 1;
  return counts;
}

/** Which proxy events a filter keeps: all of them under «all» and «accounts», the bad ones under «problems». */
export function proxyForFilter(rows: readonly ProxyEvent[], filter: HistoryFilter): ProxyEvent[] {
  if (filter === 'all' || filter === 'accounts') return [...rows];
  if (filter === 'problems') return rows.filter((e) => e.tone === 'bad');
  return [];
}

/** The count beside each chip, over what the search leaves. */
export function historyCounts(topics: number, diary: readonly DiaryEntry[], proxy: readonly ProxyEvent[] = []): Record<HistoryFilter, number> {
  const badProxy = proxy.filter((e) => e.tone === 'bad').length;
  return {
    all: topics + diary.length + proxy.length, topics, hub: diary.length, accounts: proxy.length,
    problems: diary.filter(isProblem).length + badProxy,
  };
}

/** «12 events, 3 failed» of a day: the diary's failures, Topics' lines and the proxy's events counted as events. */
export function dayTally(lines: readonly ({ diary: DiaryEntry } | { row: unknown } | { proxy: unknown })[]): { events: number; failed: number } {
  let failed = 0;
  for (const l of lines) if ('diary' in l && (l.diary.outcome === 'error' || l.diary.outcome === 'undelivered')) failed += 1;
  return { events: lines.length, failed };
}
