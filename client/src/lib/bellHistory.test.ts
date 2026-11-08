/**
 * The bell's History: filter with counts, search, the tally of a day.
 * @covers HUBBR-07
 */
import { describe, expect, test } from 'bun:test';
import { dayTally, diaryForFilter, diaryKindCounts, diaryMatches, historyCounts, isProblem, proxyForFilter, proxyMatches, topicsMatches } from './bellHistory';
import { diaryForHistory, type DiaryEntry } from './hubSystem';
import type { ProxyEvent } from './proxyEvents';

const row = (over: Partial<DiaryEntry>): DiaryEntry => ({ id: 'x', at: 1, kind: 'auto', who: 'Jarvis', title: 'Brief', outcome: null, what: '', automationKey: null, taskId: null, ...over });

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

  test('«Automazioni e agenti» narrows to one of the hub kinds, each with its count', () => {
    expect(diaryKindCounts(rows)).toEqual({ auto: 2, agente: 1, workflow: 0, tu: 0, app: 1 });
    expect(diaryForFilter(rows, 'hub', 'agente').map((r) => r.id)).toEqual(['c']);
    expect(diaryForFilter(rows, 'hub', 'auto').map((r) => r.id)).toEqual(['a', 'd']);
    // The kind applies to the hub's lump only: Problems stays Problems.
    expect(diaryForFilter(rows, 'problems', 'agente').map((r) => r.id)).toEqual(['a', 'd']);
  });

  test('a line leads where its subject lives in Topics: a workflow to its row, a job born from a card to the task', () => {
    const lines = diaryForHistory({ items: [
      { at: 3, kind: 'workflow', who: 'Workflow', title: 'Revisione', outcome: 'error', what: '', link: '#automations/wf%3Arev' },
      { at: 2, kind: 'agente', who: 'Agente · Codex', title: 'Card «Rilascio»', outcome: 'ok', what: '', link: '#automations/card%3Aacme-board%2Ftask-42' },
      // The hub's `ref` alone leads the same way.
      { at: 1, kind: 'workflow', who: 'Workflow', title: 'Audit', outcome: 'ok', what: '', ref: 'wf:audit' },
    ] });
    expect(lines.map((l) => [l.automationKey, l.taskId])).toEqual([['workflow:rev', null], [null, 'task-42'], ['workflow:audit', null]]);
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
