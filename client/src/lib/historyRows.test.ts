/**
 * The proof that the history is ONE: two different sources (closed tabs and
 * visited pages) have to come out as rows of the same type, mixed by time. If
 * one day either of them went back to travelling on its own, these cases turn
 * red before whoever is looking at the list ever notices.
  * @covers HISTORY-01, HISTORY-02
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { buildHistoryRows, historyRangeOf } from './historyRows';
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
      pages: [page('https://github.com/armonia/topics/3', T0, 'Pull request'), page('https://esempio.dev/', T0 + 1)],
      query: 'github pull',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].url).toBe('https://github.com/armonia/topics/3');
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

/**
 * HISTORY-02: the list narrows by type and by calendar day, and both filters
 * run before the cap. A filter applied after the cap would only see the rows
 * the cap let through, so the day you ask for could be empty while it holds
 * rows further down.
 */
describe('buildHistoryRows filters', () => {
  test('kind page keeps only the visited pages, newest first', () => {
    const rows = buildHistoryRows({
      closedTabs: [tab({ id: 'a', closedAt: T0 + 1_000 }), tab({ id: 'b', closedAt: T0 + 3_000 })],
      pages: [page('https://uno.dev/', T0), page('https://due.dev/', T0 + 4_000), page('https://tre.dev/', T0 + 2_000)],
      kind: 'page',
    });
    expect(rows.map((r) => r.kind)).toEqual(['page', 'page', 'page']);
    expect(rows.map((r) => r.url)).toEqual(['https://due.dev/', 'https://tre.dev/', 'https://uno.dev/']);
  });

  test('kind tab keeps only the closed tabs', () => {
    const rows = buildHistoryRows({
      closedTabs: [tab({ id: 'a', closedAt: T0 + 1_000 })],
      pages: [page('https://uno.dev/', T0 + 2_000)],
      kind: 'tab',
    });
    expect(rows.map((r) => r.id)).toEqual(['tab:a']);
  });

  test('yesterday and today split at local midnight, not 24 hours back', () => {
    const now = new Date(2026, 8, 28, 0, 10).getTime();
    const lateYesterday = new Date(2026, 8, 27, 23, 50).getTime();
    const earlyToday = new Date(2026, 8, 28, 0, 5).getTime();
    const pages = [page('https://ieri.dev/', lateYesterday), page('https://oggi.dev/', earlyToday)];
    expect(buildHistoryRows({ pages, range: 'yesterday', now }).map((r) => r.url)).toEqual(['https://ieri.dev/']);
    expect(buildHistoryRows({ pages, range: 'today', now }).map((r) => r.url)).toEqual(['https://oggi.dev/']);
  });

  test('the day filter runs before the cap', () => {
    const now = new Date(2026, 8, 28, 12, 0).getTime();
    const today = Array.from({ length: 50 }, (_, i) => page(`https://oggi-${i}.dev/`, now - (i + 1) * 60_000));
    const yesterday = page('https://ieri.dev/', new Date(2026, 8, 27, 15, 0).getTime());
    const rows = buildHistoryRows({ pages: [...today, yesterday], range: 'yesterday', limit: 40, now });
    expect(rows.map((r) => r.url)).toEqual(['https://ieri.dev/']);
  });

  test('an instant ahead of now counts as today, it never disappears', () => {
    const now = new Date(2026, 8, 28, 12, 0).getTime();
    const rows = buildHistoryRows({ closedTabs: [tab({ id: 'futuro', closedAt: now + 5 * 60_000 })], range: 'today', now });
    expect(rows.map((r) => r.id)).toEqual(['tab:futuro']);
  });

  test('range all and no range keep every row', () => {
    const now = new Date(2026, 8, 28, 12, 0).getTime();
    const pages = [page('https://oggi.dev/', now - 1_000), page('https://vecchia.dev/', now - 30 * 86_400_000)];
    expect(buildHistoryRows({ pages, range: 'all', now })).toHaveLength(2);
    expect(buildHistoryRows({ pages, now })).toHaveLength(2);
  });

  test('older is everything before yesterday', () => {
    const now = new Date(2026, 8, 28, 12, 0).getTime();
    const pages = [
      page('https://ieri.dev/', new Date(2026, 8, 27, 0, 0).getTime()),
      page('https://prima.dev/', new Date(2026, 8, 26, 23, 59).getTime()),
    ];
    expect(buildHistoryRows({ pages, range: 'older', now }).map((r) => r.url)).toEqual(['https://prima.dev/']);
  });
});

/**
 * The day that lasts 25 hours. The zone belongs to the whole process, and the
 * unit runner puts every file in one `bun test`: whatever this block leaves
 * behind is the zone of every file after it. `delete process.env.TZ` does not
 * go back to UTC under Bun 1.3.8, it freezes the zone on the last value and
 * ignores later assignments, so the effective zone read before is assigned
 * back instead (design.md section 2).
 */
const zoneAtLoad = Intl.DateTimeFormat().resolvedOptions().timeZone;

describe('historyRangeOf on the day the clocks go back', () => {
  let zoneBefore = '';
  beforeAll(() => {
    zoneBefore = Intl.DateTimeFormat().resolvedOptions().timeZone;
    process.env.TZ = 'Europe/Rome';
  });
  afterAll(() => {
    process.env.TZ = zoneBefore;
  });

  test('25 hours back is still yesterday, and the hour before it is older', () => {
    const now = new Date(2026, 9, 26, 0, 30).getTime();
    // The zone actually took: in Europe/Rome that instant is 23:30Z of the day before.
    expect(new Date(now).toISOString()).toBe('2026-10-25T23:30:00.000Z');
    const at = new Date(2026, 9, 25, 0, 30).getTime();
    expect(now - at).toBe(25 * 3_600_000);
    expect(historyRangeOf(at, now)).toBe('yesterday');
    expect(historyRangeOf(new Date(2026, 9, 24, 23, 30).getTime(), now)).toBe('older');
  });

  test('today starts at local midnight', () => {
    const now = new Date(2026, 9, 26, 0, 30).getTime();
    expect(historyRangeOf(new Date(2026, 9, 26, 0, 0).getTime(), now)).toBe('today');
    expect(historyRangeOf(new Date(2026, 9, 25, 23, 59).getTime(), now)).toBe('yesterday');
  });
});

describe('after the zone change', () => {
  test('the process is back on the zone it had, for the files that run after this one', () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(zoneAtLoad);
  });
});
