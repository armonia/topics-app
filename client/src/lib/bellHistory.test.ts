/**
 * The bell's History: filter with counts, search, the tally of a day.
 * @covers HUBBR-07
 */
import { describe, expect, test } from 'bun:test';
import { dayTally, diaryForFilter, diaryMatches, historyCounts, isProblem, proxyForFilter, proxyMatches, topicsMatches } from './bellHistory';
import type { DiaryEntry } from './hubSystem';
import type { ProxyEvent } from './proxyEvents';

const row = (over: Partial<DiaryEntry>): DiaryEntry => ({ id: 'x', at: 1, kind: 'auto', who: 'OpenClaw', title: 'Brief', outcome: null, what: '', automationKey: null, ...over });

describe('HUBBR-07: History filter, search and day tally', () => {
  const rows = [
    row({ id: 'a', title: 'Brief del mattino', outcome: 'error', what: 'exit 1' }),
    row({ id: 'b', kind: 'app', who: 'Mac', title: 'Topics app', outcome: 'error' }),
    row({ id: 'c', kind: 'agente', who: 'Agente · Codex', title: 'Ripara il reindex', outcome: 'ok' }),
    row({ id: 'd', who: 'Freno del Mac', title: 'Mac bloccato da Helium', outcome: 'undelivered' }),
  ];

  test('problems are failures and undelivered runs, never the person own apps', () => {
    expect(rows.filter(isProblem).map((r) => r.id)).toEqual(['a', 'd']);
    expect(diaryForFilter(rows, 'problems').map((r) => r.id)).toEqual(['a', 'd']);
    expect(diaryForFilter(rows, 'topics')).toEqual([]);
    expect(diaryForFilter(rows, 'hub')).toHaveLength(4);
    expect(historyCounts(3, rows)).toEqual({ all: 7, topics: 3, hub: 4, accounts: 0, problems: 2 });
    expect(diaryForFilter(rows, 'accounts')).toEqual([]);
  });

  test('the search finds every word in title, detail, who or state', () => {
    const word = (o: string) => (o === 'error' ? 'fallito' : o);
    expect(rows.filter((r) => diaryMatches(r, 'brief, fallito', word)).map((r) => r.id)).toEqual(['a']);
    expect(rows.filter((r) => diaryMatches(r, 'codex')).map((r) => r.id)).toEqual(['c']);
    expect(rows.filter((r) => diaryMatches(r, '  ')).length).toBe(4);
    expect(topicsMatches({ title: 'Review', body: 'Sign release builds' }, 'release')).toBe(true);
    expect(topicsMatches({ title: 'Review', body: 'Sign release builds' }, 'nope')).toBe(false);
  });

  test('the proxy log has its own filter, and its bad events count among the problems', () => {
    const ev = (id: string, tone: ProxyEvent['tone']): ProxyEvent => ({ id, at: 1, type: 'x', tone, family: 'other', text: { text: id }, detail: null });
    const proxy = [ev('switch', 'info'), ev('expired', 'bad'), ev('renamed', 'muted')];
    expect(historyCounts(3, rows, proxy)).toEqual({ all: 10, topics: 3, hub: 4, accounts: 3, problems: 3 });
    expect(proxyForFilter(proxy, 'accounts').map((e) => e.id)).toEqual(['switch', 'expired', 'renamed']);
    expect(proxyForFilter(proxy, 'all')).toHaveLength(3);
    expect(proxyForFilter(proxy, 'problems').map((e) => e.id)).toEqual(['expired']);
    expect(proxyForFilter(proxy, 'hub')).toEqual([]);
    expect(proxyForFilter(proxy, 'topics')).toEqual([]);
    expect(proxyMatches('Cambio automatico da lavoro a riserva errore 429 Proxy Claude', 'riserva, 429')).toBe(true);
    expect(proxyMatches('Cambio manuale a riserva', 'lavoro')).toBe(false);
  });

  test('a day says its events and how many failed', () => {
    expect(dayTally([{ diary: rows[0]! }, { diary: rows[2]! }, { diary: rows[3]! }, { row: {} }, { proxy: {} }])).toEqual({ events: 5, failed: 2 });
  });
});
