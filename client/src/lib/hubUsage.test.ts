/**
 * The hub's half of the Dashboard as pure reads: what the Claude plans cost
 * for a window, the saving against the list price, the chart's layers, the
 * share of the week per project with your cap, the project past its cap, the
 * jobs given to Muse and the accounts with their part of the tokens. Inputs
 * are the services' own shapes, trimmed, with placeholder names.
 * @covers HUBBR-12
 */
import { describe, expect, test } from 'bun:test';
import {
  accountShares, chartLayers, formatCurrency, headAndRest, museJobs, museWeekTokens, overCap, planCostForWindow, planPriceUsd, projectShares,
  readHubUsage, savingOf, tokenParts, exchangeRateOf, type HubUsage,
} from './hubUsage';

const NOW = 1_800_000_000_000;

const usage = (over: Partial<HubUsage> = {}): HubUsage => ({
  days: 7, sinceMs: NOW - 6 * 86_400_000, at: NOW, unit: 'day', buckets: [0, 1, 2],
  totals: { tokens: 1000, listUsd: 100, requests: 9 },
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
  ...over,
});

describe('HUBBR-12: the hub half of the Dashboard', () => {
  test('the server sum is read, an error object is not', () => {
    expect(readHubUsage(usage())?.totals.tokens).toBe(1000);
    expect(readHubUsage({ error: 'switchboard not reachable' })).toBeNull();
    expect(readHubUsage({ ...usage(), days: 3 })).toBeNull();
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
      { name: 'studio-x', title: 'studio-x', claude: 20, codex: 0, muse: 7, total: 27, budgetPct: 25 },
      { name: 'acme-api', title: 'acme-api', total: 14, budgetPct: null },
      { name: 'acme-docs', label: 'Docs', total: 6, budgetPct: null },
      { name: 'quiet', total: 0, budgetPct: null },
      { name: 'misc-a', total: 10 }, { name: 'misc-b', total: 5 },
    ] };
    const rows = projectShares(live);
    expect(rows.map((r) => r.name)).toEqual(['acme-web', 'studio-x', 'acme-api', 'misc-a', 'acme-docs', 'misc-b']);
    expect(rows.find((r) => r.name === 'acme-docs')!.title).toBe('Docs');
    expect(rows.filter((r) => r.over).map((r) => r.name)).toEqual(['studio-x']);
    const { head, rest } = headAndRest(rows);
    expect(head).toHaveLength(4);
    expect(rest).toEqual({ count: 2, total: 11 });
    expect(overCap(rows)).toMatchObject({ project: { name: 'studio-x' }, raiseTo: 35 });
    expect(overCap(projectShares({ projects: [{ name: 'a', total: 99, budgetPct: 95 }] }))!.raiseTo).toBe(100);
    expect(overCap(projectShares({ projects: [{ name: 'a', total: 10, budgetPct: 40 }] }))).toBeNull();
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
  });
});
