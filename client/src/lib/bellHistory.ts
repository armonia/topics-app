/**
 * The bell's History, as the hub's diary page read it (HUBBR-07): a filter
 * with its counts, a search over the words of a line, and per day how many
 * events and how many failed. Pure: the panel passes the lines it holds.
 */
import type { DiaryEntry, DiaryKind } from './hubSystem';

export type HistoryFilter = 'all' | 'topics' | 'hub' | 'problems';

export const HISTORY_FILTER_KEYS: readonly HistoryFilter[] = ['all', 'topics', 'hub', 'problems'];

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
  if (filter === 'topics') return [];
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

/** The count beside each chip, over what the search leaves. */
export function historyCounts(topics: number, diary: readonly DiaryEntry[]): Record<HistoryFilter, number> {
  return { all: topics + diary.length, topics, hub: diary.length, problems: diary.filter(isProblem).length };
}

/** «12 events, 3 failed» of a day: the diary's failures, Topics' lines counted as events. */
export function dayTally(lines: readonly ({ diary: DiaryEntry } | { row: unknown })[]): { events: number; failed: number } {
  let failed = 0;
  for (const l of lines) if ('diary' in l && (l.diary.outcome === 'error' || l.diary.outcome === 'undelivered')) failed += 1;
  return { events: lines.length, failed };
}
