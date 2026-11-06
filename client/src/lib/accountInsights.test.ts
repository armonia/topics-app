/**
 * What «Account e quote» reads past the bars, as pure reads of the proxy's and
 * the hub's own shapes, trimmed, with placeholder names: the probes and the
 * queue, each window's slices through the proxy or outside it with an honest
 * verdict, the windows' trend, and the hub board's dial, forecast, extra
 * windows, bonus, login and who spent, with the accounts no card shows.
 * @covers HUBBR-10
 */
import { describe, expect, test } from 'bun:test';
import {
  attributionVerdict, boardAccountFor, loginBroken, orphanBoardAccounts, readAccountTrails, readBoardAccounts, readProxyHealth,
} from './accountInsights';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

describe('HUBBR-10: accounts and quotas past the bars', () => {
  test('the probes of the week and the queue now; nothing to say is null', () => {
    const h = readProxyHealth({ probeStats: { probeCount7d: 9952, inputTokens: 100, outputTokens: 50 }, queueStats: { inflight: 3, queued: 2, balanceMode: false } });
    expect(h).toEqual({ probes: { count: 9952, tokens: 150 }, queue: { balance: false, running: 3, waiting: 2 } });
    expect(readProxyHealth({ queueStats: { balanceMode: true, balanceInflight: 4, balanceWaiting: 0 } }).queue).toEqual({ balance: true, running: 4, waiting: 0 });
    expect(readProxyHealth({ probeStats: { probeCount7d: 0 }, queueStats: { inflight: 0, queued: 0 } })).toEqual({ probes: null, queue: null });
    expect(readProxyHealth(null)).toEqual({ probes: null, queue: null });
  });

  test('each slice of a window is through the proxy, outside it, idle or not measured; the trend is in %, oldest first', () => {
    const band = (myTokens: number, deltaUtil: number | null) => ({ from: NOW - 2 * HOUR, to: NOW - HOUR, myTokens, myCostUsd: myTokens / 1e6, requests: 3, deltaUtil });
    const trails = readAccountTrails({ profiles: [{
      name: 'p1',
      attribution: {
        sevenD: { myTokens: 9e6, myCostUsd: 9, requests: 30, externalShare: 0.4, coverage: 0.6,
          tokenBreakdown: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 30, cacheCreationTokens: 4 },
          bands: [band(5e6, 0), band(0, 0.04), band(0, 0), band(0, null), { from: 'x' }] },
      },
      utilizationHistory: [{ ts: NOW, u5h: 0.3 }, { ts: NOW - HOUR, u5h: 0.1 }],
      weeklyHistory: [{ ts: NOW, u7d: 0.92 }],
    }, { label: 'no name' }] });
    expect([...trails.keys()]).toEqual(['p1']);
    const t = trails.get('p1')!;
    expect(t.week!.bands.map((b) => b.kind)).toEqual(['mine', 'outside', 'idle', 'unknown']);
    expect(t.week!.bands[1]!.deltaPct).toBe(4);
    expect(t.week).toMatchObject({ tokens: 9e6, io: 3, cache: 34, externalShare: 0.4 });
    expect(t.fiveH).toBeNull();
    expect(t.history5h).toEqual([{ ts: NOW - HOUR, pct: 10 }, { ts: NOW, pct: 30 }]);
    expect(t.historyWeek).toEqual([{ ts: NOW, pct: 92 }]);
  });

  test('the verdict says internal and external only where it was measured on a quarter of the window', () => {
    const w = (externalShare: number | null, coverage: number) => ({ bands: [], tokens: 0, usd: 0, requests: 0, io: 0, cache: 0, externalShare, coverage });
    expect(attributionVerdict(w(0.4, 0.6))).toEqual({ kind: 'measured', internalPct: 60, externalPct: 40 });
    expect(attributionVerdict(w(0.35, 0.1))).toEqual({ kind: 'partial', coveragePct: 10, externalPct: 35 });
    expect(attributionVerdict(w(null, 0.9))).toEqual({ kind: 'unmeasured' });
  });

  test("the board's accounts: dial only where the pace is measured, extra windows past the 5 hours and the week, the login", () => {
    const board = { accounts: [
      { provider: 'claude', email: 'lavoro@example.com', gauge: { needle: 1.7, value: 1.7, reason: 'sopra' }, state: { dial: true, zone: 'sopra', tone: 'warn', text: 'sopra ritmo' },
        windows: [{ key: 'week', used: 92 }, { key: '5h', used: 30 }, { key: 'day', label: '24 h', used: 30, mark: 14, tone: 'bad' }, { key: 'model:Fable', label: 'Fable', used: 12 }],
        bonus: { left: 40, limit: 250, used: 84, renews: '05/12' }, access: { state: 'ok', say: 'Collegato.', resets: { week: { say: 'Settimana: gio' } }, link: 'https://example.com' },
        top: [{ name: 'acme-web', tokens: 5, pct: 77 }], end: { text: 'sab 04:46', tone: 'bad' }, tokens: { left: '~360 M', perDay: '380 M/24 h' } },
      { provider: 'codex', email: 'vecchio@example.com', gauge: { needle: null }, state: { tone: 'bad', text: 'accesso da rifare' }, access: { state: 'scaduto', say: 'Accesso scaduto.' } },
      { provider: 'muse' },
    ] };
    const list = readBoardAccounts(board);
    expect(list).toHaveLength(2);
    const a = list[0]!;
    expect(a.dial).toEqual({ needle: 1.7, value: 1.7, zone: 'sopra' });
    expect(a.windows.map((w) => w.key)).toEqual(['day', 'model:Fable']);
    expect(a.windows[0]).toMatchObject({ mark: 14, tone: 'bad' });
    expect(a.bonus).toMatchObject({ left: 40, limit: 250, renews: '05/12', stale: false });
    expect(a.access).toMatchObject({ state: 'ok', week: 'Settimana: gio', fiveH: null });
    expect(a.end).toMatchObject({ text: 'sab 04:46', tone: 'bad' });
    expect(list[1]!.dial).toBeNull();
    expect(loginBroken(list[1]!)).toBe(true);
    expect(loginBroken(a)).toBe(false);
    expect(boardAccountFor(list, 'claude', 'LAVORO@example.com', 'p1')).toBe(a);
    expect(boardAccountFor(list, 'codex', 'lavoro@example.com')).toBeNull();
    expect(orphanBoardAccounts(list, [{ provider: 'claude', names: ['lavoro@example.com'] }]).map((b) => b.account)).toEqual(['vecchio@example.com']);
    expect(readBoardAccounts({ error: 'down' })).toEqual([]);
  });
});
