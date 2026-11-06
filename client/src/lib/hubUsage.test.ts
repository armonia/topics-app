/**
 * The hub's half of the Dashboard as pure reads: what the Claude plans cost
 * for a window, the saving against the list price, the chart's layers, the
 * share of the week per project with your cap, the project past its cap, the
 * jobs given to Muse and the accounts with their part of the tokens (removed
 * ones included); the Ultra plan priced, the cap read on the Claude week as
 * the hub's brake reads it, a project's requests and who made them, Muse per
 * folder, the proxy's attribution and the saving curve. Inputs are the
 * services' own shapes, trimmed, with placeholder names.
 * @covers HUBBR-12
 */
import { describe, expect, test } from 'bun:test';
import {
  accountShares, bucketTotals, chartLayers, formatCurrency, headAndRest, museFolders, museJobs, museWeekTokens, overCap, planCostForWindow, planPriceUsd,
  projectDetails, projectShares, proxyAttribution, readHubUsage, savingCurve, savingOf, tokenParts, exchangeRateOf, type HubUsage,
} from './hubUsage';

const NOW = 1_800_000_000_000;

const usage = (over: Partial<HubUsage> = {}): HubUsage => ({
  days: 7, sinceMs: NOW - 6 * 86_400_000, at: NOW, unit: 'day', buckets: [0, 1, 2],
  totals: { tokens: 1000, listUsd: 100, requests: 9, inputTokens: 40, outputTokens: 60 },
  models: [
    { key: 'claude-opus-5-5', tokens: 600, listUsd: 80, requests: 3 },
    { key: 'claude-sonnet-5-5', tokens: 300, listUsd: 15, requests: 3 },
    { key: 'claude-haiku-5-5', tokens: 100, listUsd: 5, requests: 3 },
  ],
  accounts: [{ key: 'lavoro@example.com', tokens: 750, listUsd: 75, requests: 6 }, { key: 'riserva@example.com', tokens: 250, listUsd: 25, requests: 3 }],
  series: [
    { model: 'claude-opus-5-5', tokens: [100, 200, 300], listUsd: [10, 30, 40] },
    { model: 'claude-sonnet-5-5', tokens: [100, 100, 100], listUsd: [5, 5, 5] },
    { model: 'claude-haiku-5-5', tokens: [0, 50, 50], listUsd: [0, 2, 3] },
  ],
  coverage: { partial: false, fromMs: null },
  repos: [{ key: 'acme-web', tokens: 1000, listUsd: 100, requests: 9, branches: [{ key: 'main', tokens: 1000, listUsd: 100, requests: 9 }] }],
  filter: { model: null, account: null, repo: null },
  options: { models: ['claude-opus-5-5'], accounts: ['lavoro@example.com'], repos: ['acme-web'] },
  ...over,
});

describe('HUBBR-12: the hub half of the Dashboard', () => {
  test('the server sum is read, an error object is not', () => {
    expect(readHubUsage(usage())?.totals.tokens).toBe(1000);
    expect(readHubUsage({ error: 'switchboard not reachable' })).toBeNull();
    expect(readHubUsage({ ...usage(), days: 3 })).toBeNull();
    // A server from before the filter: the newer parts read as empty, never as missing.
    const { repos: _r, filter: _f, options: _o, ...old } = usage();
    const read = readHubUsage({ ...old, totals: { tokens: 1, listUsd: 1, requests: 1 } })!;
    expect(read.repos).toEqual([]);
    expect(read.options.models).toEqual([]);
    expect(read.totals.inputTokens).toBe(0);
  });

  test('Ultra is the old Max 20x: 200 a month whatever the token says; one account alone pays its own plan', () => {
    expect(planPriceUsd('ultra', '')).toBe(200);
    expect(planPriceUsd('max', 'default_claude_ultra')).toBe(200);
    expect(planPriceUsd('max', 'default_claude_max_40x')).toBe(200);
    const profiles = { profiles: [
      { name: 'a', label: 'lavoro@example.com', subscriptionType: 'ultra', rateLimitTier: 'default_claude_ultra' },
      { name: 'b', label: 'riserva@example.com', subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' },
    ] };
    expect(planCostForWindow(profiles, 30)).toEqual({ usd: 300, plans: 2, unpriced: 0 });
    expect(planCostForWindow(profiles, 30, 'riserva@example.com')).toEqual({ usd: 100, plans: 1, unpriced: 0 });
    expect(planCostForWindow(profiles, 30, 'a')!.usd).toBe(200);
  });

  test('plans: Max 20x 200, Max 5x 100, Pro 20 a month, spread over the window; an unknown plan is not free', () => {
    expect(planPriceUsd('max', 'default_claude_max_20x')).toBe(200);
    expect(planPriceUsd('max', 'default_claude_max_5x')).toBe(100);
    expect(planPriceUsd('pro', '')).toBe(20);
    expect(planPriceUsd('free', '')).toBeNull();
    const profiles = { profiles: [
      { name: 'a', subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' },
      { name: 'b', subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' },
      { name: 'c', subscriptionType: 'free' },
    ] };
    expect(planCostForWindow(profiles, 30)).toEqual({ usd: 300, plans: 2, unpriced: 1 });
    expect(planCostForWindow(profiles, 7)!.usd).toBeCloseTo(70, 6);
    expect(planCostForWindow({ error: 'down' }, 7)).toBeNull();
  });

  test('the saving is the list price less what is paid, never below zero', () => {
    expect(savingOf(1284, 104)).toEqual({ savedUsd: 1180, ratio: 1284 / 104 });
    expect(savingOf(50, 104).savedUsd).toBe(0);
    expect(savingOf(50, 0).ratio).toBeNull();
  });

  test('amounts in euro at the proxy rate, Italian style', () => {
    expect(exchangeRateOf({ usdEur: 0.9 })).toBe(0.9);
    expect(exchangeRateOf(null)).toBe(0.92);
    expect(formatCurrency(1000, 0.9, 'it')).toBe('900 €');
    expect(formatCurrency(10, 0.9, 'it')).toBe('9 €');
    expect(formatCurrency(1, 0.92, 'it')).toBe('0,92 €');
    expect(tokenParts(182_400_000, 'it')).toEqual({ value: '182', unit: 'M' });
    expect(tokenParts(9_140_000, 'it')).toEqual({ value: '9,1', unit: 'M' });
  });

  test('the chart keeps the first models and sums the rest as one layer', () => {
    const layers = chartLayers(usage(), 'tokens', 2);
    expect(layers.map((l) => l.key)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'other']);
    expect(layers[2]!.values).toEqual([0, 50, 50]);
    expect(chartLayers(usage(), 'listUsd')[0]!.values).toEqual([10, 30, 40]);
  });

  test('per project the share of the week, your cap as a marker, the rest summed', () => {
    const live = { projects: [
      { name: 'acme-web', title: 'acme-web', claude: 30, codex: 2, muse: 6, total: 38, budgetPct: 40 },
      { name: 'studio-x', title: 'studio-x', claude: 25, codex: 0, muse: 2, total: 27, budgetPct: 25, what: 'Uno studio' },
      { name: 'acme-api', title: 'acme-api', total: 14, budgetPct: null },
      { name: 'acme-docs', label: 'Docs', total: 6, budgetPct: null },
      { name: 'quiet', total: 0, budgetPct: null },
      { name: 'misc-a', total: 10 }, { name: 'misc-b', total: 5 },
    ] };
    const rows = projectShares(live);
    expect(rows.map((r) => r.name)).toEqual(['acme-web', 'studio-x', 'acme-api', 'misc-a', 'acme-docs', 'misc-b']);
    expect(rows.find((r) => r.name === 'acme-docs')!.title).toBe('Docs');
    // The cap is on the Claude week, at the cap or past it, as the hub's brake: studio-x at 25 on 25 is held, acme-web at 30 on 40 is not.
    expect(rows.filter((r) => r.over).map((r) => r.name)).toEqual(['studio-x']);
    expect(rows.find((r) => r.name === 'studio-x')).toMatchObject({ shown: 25, what: 'Uno studio' });
    expect(rows.find((r) => r.name === 'acme-api')).toMatchObject({ shown: 14, what: null });
    // Claude 20 + Codex 10 on a 25% cap: the brake does not hold it, so neither does the view.
    expect(projectShares({ projects: [{ name: 'a', claude: 20, codex: 10, total: 30, budgetPct: 25 }] })[0]!.over).toBe(false);
    const { head, rest } = headAndRest(rows);
    expect(head).toHaveLength(4);
    expect(rest).toMatchObject({ count: 2, total: 11 });
    expect(rest!.rows.map((r) => r.name)).toEqual(['acme-docs', 'misc-b']);
    expect(overCap(rows)).toMatchObject({ project: { name: 'studio-x' }, raiseTo: 35 });
    expect(overCap(projectShares({ projects: [{ name: 'a', claude: 99, total: 99, budgetPct: 95 }] }))!.raiseTo).toBe(100);
    expect(overCap(projectShares({ projects: [{ name: 'a', claude: 10, total: 10, budgetPct: 40 }] }))).toBeNull();
  });

  test('Muse: jobs of the queue in the window, tokens of the week', () => {
    const queue = { items: [
      { provider: 'muse', createdAt: NOW - 1000 }, { provider: 'muse', createdAt: NOW - 10 * 86_400_000 },
      { provider: 'codex', createdAt: NOW - 1000 },
    ] };
    expect(museJobs(queue, NOW - 86_400_000)).toBe(1);
    expect(museJobs({ error: 'x' }, 0)).toBeNull();
    expect(museWeekTokens({ muse: { projects: [{ tokens: 5 }, { tokens: 7 }] } })).toBe(12);
    expect(museWeekTokens({})).toBeNull();
  });

  test('accounts carry their windows and their part of the tokens, matched by label', () => {
    const profiles = { profiles: [
      { name: 'p1', label: 'lavoro@example.com', isActive: true, rateLimits: { fiveH: { utilization: 0.41, reset: NOW / 1000 + 3600 }, sevenD: { utilization: 0.84, reset: NOW / 1000 + 86_400 } } },
      { name: 'p2', label: 'riserva@example.com', rateLimits: { sevenD: { utilization: 0.47, reset: NOW / 1000 + 86_400 } } },
      { name: 'p3', label: 'muto@example.com', rateLimits: {} },
    ] };
    const rows = accountShares(profiles, usage(), NOW);
    expect(rows.map((r) => [r.label, r.inUse, r.share, r.week?.pct ?? null])).toEqual([
      ['lavoro@example.com', true, 75, 84],
      ['riserva@example.com', false, 25, 47],
      ['muto@example.com', false, null, null],
    ]);
    expect(rows[0]).toMatchObject({ tokens: 750, listUsd: 75, requests: 6, removed: false });
    // An account the window's rows name and the proxy no longer has: kept, said removed, so the shares add up.
    const gone = accountShares({ profiles: profiles.profiles.slice(0, 1) }, usage(), NOW);
    expect(gone.map((r) => [r.label, r.removed, r.share])).toEqual([['lavoro@example.com', false, 75], ['riserva@example.com', true, 25]]);
  });

  test('per project the requests and who made them; Muse per folder; the proxy\'s attribution', () => {
    const report = {
      projects: [{ name: 'acme-web', requests: 9231, tokens: 2.5e8, lastAt: NOW, subRequests: 7522, subWeekPct: 15.3, jarvisRequests: 0, jarvisWeekPct: 0, jcodeRequests: 75, jcodeWeekPct: 0.1 }],
      muse: { projects: [{ name: 'b', weekPct: 4.5, requests: 302, tokens: 4.5e7, lastAt: NOW }, { name: 'a', weekPct: 51.7, requests: 3499, tokens: 5.2e8 }] },
      proxy: { available: true, requests: 14569, withoutCwd: 0, blindSessions: 27, coverage: { from: NOW - 1000, to: NOW }, projects: [{ name: 'tmp', tokens: 3e8, requests: 11251, needsLogs: false }, { name: 'x', requests: 3, needsLogs: true }] },
    };
    const d = projectDetails(report).get('acme-web')!;
    expect(d).toMatchObject({ requests: 9231, sub: { pct: 15.3, requests: 7522 }, jarvis: null, jcode: { pct: 0.1, requests: 75 } });
    expect(museFolders(report)!.map((f) => f.name)).toEqual(['a', 'b']);
    expect(museFolders({})).toBeNull();
    expect(proxyAttribution(report)).toMatchObject({ requests: 14569, blindSessions: 27, folders: [{ name: 'tmp', fromLogs: false }, { name: 'x', fromLogs: true, tokens: 0 }] });
    expect(proxyAttribution({ proxy: { available: false, note: 'proxy spento' } })).toEqual({ note: 'proxy spento' });
    expect(proxyAttribution({})).toBeNull();
  });

  test('the saving curve sums the list price bucket by bucket against the plans spread over the window', () => {
    const points = savingCurve(usage(), 70);
    expect(points.map((p) => p.list)).toEqual([15, 52, 100]);
    expect(points.map((p) => p.plan)).toEqual([10, 20, 30]);
    expect(savingCurve(usage({ unit: 'hour', days: 1 }), 24).map((p) => p.plan)).toEqual([1, 2, 3]);
    expect(bucketTotals(usage(), 1)).toEqual({ tokens: 350, listUsd: 37 });
  });
});
