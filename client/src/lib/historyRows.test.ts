/**
 * The proof that the history is ONE: two different sources (closed tabs and
 * visited pages) have to come out as rows of the same type, mixed by time. If
 * one day either of them went back to travelling on its own, these cases turn
 * red before whoever is looking at the list ever notices.
 */
import { describe, test, expect } from 'bun:test';
import { buildHistoryRows } from './historyRows';
import type { ClosedTabRecord } from '../state/pane/adapters/closedTabRecord';
import type { PageVisit } from '../state/browserSiteHistory';

const T0 = Date.parse('2026-05-10T12:00:00Z');

function tab(over: Partial<ClosedTabRecord> & { id: string; closedAt: number }): ClosedTabRecord {
  return {
    groupId: 'standalone',
    groupIndex: 0,
    level: 'app',
    pane: { id: 'chat:1', type: 'chat', title: 'Una chat' },
    ...over,
  } as ClosedTabRecord;
}

function page(url: string, at: number, title = ''): PageVisit {
  return { url, title, favicon: '', at };
}

describe('buildHistoryRows', () => {
  test('mescola le due sorgenti in ordine di tempo, dal più recente', () => {
    const rows = buildHistoryRows({
      closedTabs: [tab({ id: 'a', closedAt: T0 + 2_000 })],
      pages: [page('https://esempio.dev/x', T0 + 5_000), page('https://altro.dev/y', T0)],
    });
    expect(rows.map((r) => r.id)).toEqual(['page:https://esempio.dev/x', 'tab:a', 'page:https://altro.dev/y']);
    expect(rows[1].kind).toBe('tab');
  });

  test('una pagina senza titolo si presenta col proprio indirizzo, accorciato', () => {
    const rows = buildHistoryRows({ pages: [page('https://www.esempio.dev/', T0)] });
    expect(rows[0].label).toBe('esempio.dev');
    expect(rows[0].detail).toBe('esempio.dev');
  });

  test('una tab browser chiusa porta con sé il suo indirizzo', () => {
    const rows = buildHistoryRows({
      closedTabs: [tab({
        id: 'b',
        closedAt: T0,
        pane: { id: 'browser:ctx', type: 'browser', title: '', url: 'https://esempio.dev/pagina' },
      })],
    });
    expect(rows[0].label).toBe('esempio.dev/pagina');
    expect(rows[0].url).toBe('https://esempio.dev/pagina');
    expect(rows[0].paneType).toBe('browser');
    expect(rows[0].record?.id).toBe('b');
  });

  test('la ricerca vuole TUTTE le parole, anche in campi diversi', () => {
    const rows = buildHistoryRows({
      pages: [page('https://github.com/armonia/pull/3', T0, 'Pull request'), page('https://esempio.dev/', T0 + 1)],
      query: 'github pull',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].url).toBe('https://github.com/armonia/pull/3');
  });

  test('il tetto taglia dopo aver ordinato, non prima', () => {
    const rows = buildHistoryRows({
      pages: [page('https://a.dev/', T0), page('https://b.dev/', T0 + 10_000)],
      limit: 1,
    });
    expect(rows.map((r) => r.url)).toEqual(['https://b.dev/']);
  });

  test('senza sorgenti torna un elenco vuoto, non esplode', () => {
    expect(buildHistoryRows({})).toEqual([]);
  });
});
