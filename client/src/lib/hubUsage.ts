/**
 * CONSUMI IN THE DASHBOARD (hub-smistamento, HUBBR-12): the reads behind the
 * hub's half of the Dashboard, turned into what it draws.
 *
 *   /api/hub-usage?days=        the Claude proxy's rows of the window, summed
 *                               by the Topics server (shared/hub-usage.ts)
 *   /api/switchboard/profiles   the Claude plans (what is paid) and the accounts
 *   /api/switchboard/settings   the dollar to euro rate
 *   /api/hub/live               per project the share of the week, and your cap
 *   /api/hub/queue              the jobs given to Muse
 *   /api/hub/projects           the tokens Muse took off Claude this week, per
 *                               project the requests and who made them
 *                               (subagents, Jarvis, jcode), Muse per folder,
 *                               and how the proxy attributed its requests
 *
 * The saving against the list price is Claude's only: the proxy sees only
 * Claude, and a Codex or Muse figure would be a guess written as a number.
 * Pure on purpose: the wire shapes are the part that can be wrong in silence.
 */
import { HUB_USAGE_DAYS, type HubUsage, type HubUsageDays, type HubUsageFilter, type HubUsageSlice } from '../../../shared/hub-usage';
import { readProxyAccounts, type QuotaWindow } from './accountQuotas';

export { HUB_USAGE_DAYS };
export type { HubUsage, HubUsageDays, HubUsageFilter };

type JsonObject = Record<string, unknown>;
const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** The days a monthly plan price is spread over. */
const MONTH_DAYS = 30;

/** The server's sum, or null when the answer is not it (proxy down, an error object). */
export function readHubUsage(raw: unknown): HubUsage | null {
  if (!isObject(raw) || !(HUB_USAGE_DAYS as readonly unknown[]).includes(raw.days)) return null;
  if (!isObject(raw.totals) || !Array.isArray(raw.models) || !Array.isArray(raw.accounts) || !Array.isArray(raw.series) || !Array.isArray(raw.buckets)) return null;
  // A server from before the filter: the newer parts read as empty, never as missing.
  const r = raw as unknown as HubUsage;
  return {
    ...r,
    totals: { ...r.totals, inputTokens: num(r.totals.inputTokens) ?? 0, outputTokens: num(r.totals.outputTokens) ?? 0 },
    repos: Array.isArray(r.repos) ? r.repos : [],
    filter: isObject(r.filter) ? r.filter : { model: null, account: null, repo: null },
    options: isObject(r.options) ? r.options : { models: [], accounts: [], repos: [] },
  };
}

/**
 * The list price of a Claude plan in dollars a month, from the proxy's
 * subscription and tier: Ultra (the old Max 20x, and any tier of 20x or more)
 * 200, Max 5x 100, Pro 20. Null for a plan whose price is not known here: it
 * is said apart, never counted as free.
 */
export function planPriceUsd(sub: unknown, tier: unknown): number | null {
  const s = String(sub ?? '').toLowerCase();
  const t = String(tier ?? '').toLowerCase();
  // The token still says default_claude_max_20x, and may stop: «ultra» is the same 200.
  if (s === 'ultra' || t.includes('ultra') || Number(/(\d+)x/.exec(t)?.[1] ?? 0) >= 20) return 200;
  if (s === 'max' || t.includes('max')) return 100;
  if (s === 'pro' || t.includes('pro')) return 20;
  return null;
}

export interface PlanCost {
  /** What the Claude plans cost for the window, in dollars. */
  usd: number;
  plans: number;
  /** Plans the proxy lists whose price is not known here. */
  unpriced: number;
}

/**
 * The Claude plans of the proxy, their monthly price spread over the window's
 * days. With `account` only that account's plan: the saving of one account is
 * its tokens against its own plan.
 */
export function planCostForWindow(profiles: unknown, days: HubUsageDays, account: string | null = null): PlanCost | null {
  if (!isObject(profiles) || !Array.isArray(profiles.profiles)) return null;
  let usd = 0;
  let plans = 0;
  let unpriced = 0;
  for (const p of profiles.profiles) {
    if (!isObject(p)) continue;
    if (account !== null && p.label !== account && p.name !== account) continue;
    const price = planPriceUsd(p.subscriptionType, p.rateLimitTier);
    if (price === null) { unpriced++; continue; }
    plans++;
    usd += (price * days) / MONTH_DAYS;
  }
  return { usd, plans, unpriced };
}

/** Saved against the list price and how many times the plans paid for themselves; null ratio when nothing is paid. */
export function savingOf(listUsd: number, paidUsd: number): { savedUsd: number; ratio: number | null } {
  return { savedUsd: Math.max(0, listUsd - paidUsd), ratio: paidUsd > 0 ? listUsd / paidUsd : null };
}

/** The proxy's dollar to euro rate; the proxy's own default when it does not answer. */
export function exchangeRateOf(settings: unknown): number {
  const v = isObject(settings) ? num(settings.usdEur) : null;
  return v !== null && v > 0 ? v : 0.92;
}

export interface ChartLayer {
  /** A model id, or `other` for the models past the first four. */
  key: string;
  values: number[];
}

/** The four models with most tokens, the rest summed as one layer, in the order they stack. */
export function chartLayers(usage: HubUsage, metric: 'tokens' | 'listUsd', keep = 4): ChartLayer[] {
  const top = usage.series.slice(0, keep).map((s) => ({ key: s.model, values: s[metric].slice() }));
  const rest = usage.series.slice(keep);
  if (rest.length) {
    top.push({ key: 'other', values: usage.buckets.map((_, i) => rest.reduce((sum, s) => sum + (s[metric][i] ?? 0), 0)) });
  }
  return top.filter((l) => l.values.some((v) => v > 0));
}

/** A slice's share of the window's tokens, in whole %. */
export function sharePct(slice: HubUsageSlice, usage: HubUsage): number {
  return usage.totals.tokens > 0 ? Math.round((100 * slice.tokens) / usage.totals.tokens) : 0;
}

export interface ProjectShare {
  name: string;
  title: string;
  /** What the project is, in the hub's words; null when it does not say. */
  what: string | null;
  /** Share of the week, Claude + Codex + Muse, in %. */
  total: number;
  claude: number;
  codex: number;
  muse: number;
  /**
   * The cap you set, in % of the CLAUDE week, as the hub's brake reads it
   * (pacing.mjs `gate`: Codex and Muse have other units and are not summed);
   * null when there is none.
   */
  budgetPct: number | null;
  /** The figure the bar draws against the cap: the Claude share where a cap is set, the whole week otherwise. */
  shown: number;
  /** At or past the cap, the moment the hub's brake holds the project. */
  over: boolean;
}

/** Per project the share of the week, from the hub's live projects: most first, the empty ones out. */
export function projectShares(live: unknown): ProjectShare[] {
  const rows = isObject(live) && Array.isArray(live.projects) ? live.projects.filter(isObject) : [];
  const out: ProjectShare[] = [];
  for (const p of rows) {
    const name = str(p.name);
    if (!name) continue;
    const total = num(p.total) ?? 0;
    const budgetPct = num(p.budgetPct);
    if (total <= 0 && budgetPct === null) continue;
    const claude = num(p.claude) ?? 0;
    out.push({
      name,
      title: str(p.label) ?? str(p.title) ?? name,
      what: str(p.what),
      total,
      claude,
      codex: num(p.codex) ?? 0,
      muse: num(p.muse) ?? 0,
      budgetPct,
      shown: budgetPct !== null ? claude : total,
      over: budgetPct !== null && claude >= budgetPct,
    });
  }
  return out.sort((a, b) => b.total - a.total || a.title.localeCompare(b.title));
}

/** The first rows as they are and the rest summed into one row that opens on the rows themselves. */
export function headAndRest(rows: ProjectShare[], keep = 4): { head: ProjectShare[]; rest: { count: number; total: number; rows: ProjectShare[] } | null } {
  const tail = rows.slice(keep);
  return { head: rows.slice(0, keep), rest: tail.length ? { count: tail.length, total: tail.reduce((s, r) => s + r.total, 0), rows: tail } : null };
}

/**
 * The decision that is yours: the project furthest past the cap you set, with
 * the cap ten points higher as the one-click raise (never past 100). The same
 * rule as the hub's brake and the project row: Claude's share at the cap or past it.
 */
export function overCap(rows: ProjectShare[]): { project: ProjectShare; raiseTo: number } | null {
  const over = rows.filter((r) => r.over && r.budgetPct !== null).sort((a, b) => (b.claude - (b.budgetPct ?? 0)) - (a.claude - (a.budgetPct ?? 0)))[0];
  if (!over || over.budgetPct === null) return null;
  const raiseTo = Math.min(100, Math.max(Math.ceil(over.claude / 5) * 5, over.budgetPct + 10));
  return raiseTo > over.budgetPct ? { project: over, raiseTo } : null;
}

/** Jobs of the hub's queue given to Muse since the window's start. */
export function museJobs(queue: unknown, sinceMs: number): number | null {
  const items = isObject(queue) && Array.isArray(queue.items) ? queue.items : Array.isArray(queue) ? queue : null;
  if (!items) return null;
  return items.filter((q) => isObject(q) && q.provider === 'muse' && (num(q.createdAt) ?? 0) >= sinceMs).length;
}

/** The tokens Muse worked this week, summed over its projects; null when the hub does not say. */
export function museWeekTokens(projects: unknown): number | null {
  const m = isObject(projects) && isObject(projects.muse) ? projects.muse : null;
  if (!m || !Array.isArray(m.projects)) return null;
  return m.projects.filter(isObject).reduce((s, p) => s + (num(p.tokens) ?? 0), 0);
}

export interface AccountShare {
  label: string;
  inUse: boolean;
  disabled: boolean;
  /** Carried tokens in the window but no longer among the proxy's accounts. */
  removed: boolean;
  /** What it carried in the window; zero when nothing. */
  tokens: number;
  listUsd: number;
  requests: number;
  fiveH: QuotaWindow | null;
  week: QuotaWindow | null;
  /** Share of the window's Claude tokens through this account, in %; null when it carried none. */
  share: number | null;
}

/**
 * The proxy's Claude accounts with their windows and what they carried in the
 * window, switched-off ones included; then every account the window's rows
 * name that the proxy no longer has, so the shares still add up to the whole.
 */
export function accountShares(profiles: unknown, usage: HubUsage | null, now = Date.now()): AccountShare[] {
  const proxy = readProxyAccounts(profiles, now);
  const used = new Set<HubUsageSlice>();
  const carried = (slice: HubUsageSlice | undefined) => ({
    tokens: slice?.tokens ?? 0, listUsd: slice?.listUsd ?? 0, requests: slice?.requests ?? 0,
    share: slice && usage ? sharePct(slice, usage) : null,
  });
  const known = (proxy?.accounts ?? []).map((a): AccountShare => {
    const slice = usage?.accounts.find((s) => s.key === a.label || s.key === a.name);
    if (slice) used.add(slice);
    return { label: a.label, inUse: a.active, disabled: a.disabled, removed: false, fiveH: a.fiveH, week: a.week, ...carried(slice) };
  });
  const gone = (usage?.accounts ?? []).filter((s) => !used.has(s) && s.tokens > 0)
    .map((s): AccountShare => ({ label: s.key, inUse: false, disabled: false, removed: true, fiveH: null, week: null, ...carried(s) }));
  return [...known, ...gone];
}

export interface ProjectDetail {
  requests: number;
  tokens: number;
  lastAt: number | null;
  /** Of the project's Claude week: the part started by subagents, by Jarvis, by jcode (outside the proxy). */
  sub: { pct: number; requests: number } | null;
  jarvis: { pct: number; requests: number } | null;
  jcode: { pct: number; requests: number } | null;
}

const part = (pct: unknown, requests: unknown) => {
  const r = num(requests);
  return r !== null && r > 0 ? { pct: num(pct) ?? 0, requests: r } : null;
};

/** Per project of the hub's weekly report, by name: requests, tokens, last activity and who made them. */
export function projectDetails(projects: unknown): Map<string, ProjectDetail> {
  const rows = isObject(projects) && Array.isArray(projects.projects) ? projects.projects.filter(isObject) : [];
  const out = new Map<string, ProjectDetail>();
  for (const p of rows) {
    const name = str(p.name);
    if (!name) continue;
    out.set(name, {
      requests: num(p.requests) ?? 0,
      tokens: num(p.tokens) ?? 0,
      lastAt: num(p.lastAt),
      sub: part(p.subWeekPct, p.subRequests),
      jarvis: part(p.jarvisWeekPct, p.jarvisRequests),
      jcode: part(p.jcodeWeekPct, p.jcodeRequests),
    });
  }
  return out;
}

export interface MuseFolder {
  name: string;
  weekPct: number;
  requests: number;
  tokens: number;
  lastAt: number | null;
}

/** Muse per folder this week, most first; null when the hub does not say. */
export function museFolders(projects: unknown): MuseFolder[] | null {
  const m = isObject(projects) && isObject(projects.muse) ? projects.muse : null;
  if (!m || !Array.isArray(m.projects)) return null;
  return m.projects.filter(isObject).flatMap((p) => {
    const name = str(p.name);
    return name ? [{ name, weekPct: num(p.weekPct) ?? 0, requests: num(p.requests) ?? 0, tokens: num(p.tokens) ?? 0, lastAt: num(p.lastAt) }] : [];
  }).sort((a, b) => b.weekPct - a.weekPct || b.tokens - a.tokens);
}

export interface ProxyAttribution {
  requests: number;
  fromMs: number | null;
  toMs: number | null;
  /** Sessions whose folder the proxy never saw, and requests left without a folder. */
  blindSessions: number;
  withoutCwd: number;
  folders: Array<{ name: string; requests: number; tokens: number; fromLogs: boolean }>;
}

/**
 * How the proxy put its requests in folders: when it read the folder itself,
 * and when the hub had to recover it from the session logs. Null when the hub
 * has no proxy; `note` alone when the proxy is there but says why it cannot.
 */
export function proxyAttribution(projects: unknown): ProxyAttribution | { note: string } | null {
  const px = isObject(projects) && isObject(projects.proxy) ? projects.proxy : null;
  if (!px) return null;
  if (px.available !== true) return { note: str(px.note) ?? '' };
  const coverage = isObject(px.coverage) ? px.coverage : {};
  return {
    requests: num(px.requests) ?? 0,
    fromMs: num(coverage.from),
    toMs: num(coverage.to),
    blindSessions: num(px.blindSessions) ?? 0,
    withoutCwd: num(px.withoutCwd) ?? 0,
    folders: (Array.isArray(px.projects) ? px.projects.filter(isObject) : []).flatMap((p) => {
      const name = str(p.name);
      return name ? [{ name, requests: num(p.requests) ?? 0, tokens: num(p.tokens) ?? 0, fromLogs: p.needsLogs === true }] : [];
    }),
  };
}

/**
 * The saving over the window, bucket by bucket: the list price summed so far
 * against what the plans cost so far. Where the first line crosses the second
 * the plans paid for themselves. Hours spread a day's plan over 24.
 */
export function savingCurve(usage: HubUsage, planUsd: number): Array<{ list: number; plan: number }> {
  const perBucket = usage.unit === 'hour' ? planUsd / 24 : planUsd / usage.days;
  let list = 0;
  return usage.buckets.map((_, i) => {
    list += usage.series.reduce((s, m) => s + (m.listUsd[i] ?? 0), 0);
    return { list, plan: perBucket * (i + 1) };
  });
}

/** One bucket's tokens and list price over every model. */
export function bucketTotals(usage: HubUsage, i: number): { tokens: number; listUsd: number } {
  return usage.series.reduce((t, m) => ({ tokens: t.tokens + (m.tokens[i] ?? 0), listUsd: t.listUsd + (m.listUsd[i] ?? 0) }), { tokens: 0, listUsd: 0 });
}

/** Tokens as a person reads them: «182 M», «9,1 M», «840 k»; the number and its unit apart. */
export function tokenParts(n: number, locale: string): { value: string; unit: string } {
  const fmt = (v: number, digits: number) => v.toLocaleString(locale === 'it' ? 'it-IT' : 'en-US', { maximumFractionDigits: digits });
  if (n >= 1e9) return { value: fmt(n / 1e9, n >= 1e10 ? 0 : 1), unit: 'G' };
  if (n >= 1e6) return { value: fmt(n / 1e6, n >= 1e8 ? 0 : 1), unit: 'M' };
  if (n >= 1e3) return { value: fmt(n / 1e3, 0), unit: 'k' };
  return { value: fmt(n, 0), unit: '' };
}

/** Dollars of the list price as euro at the proxy's rate: whole euro from 100 up, cents below. */
export function formatCurrency(usd: number, exchangeRate: number, locale: string): string {
  const v = usd * exchangeRate;
  return new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-US', {
    style: 'currency', currency: 'EUR', maximumFractionDigits: Math.abs(v) >= 100 ? 0 : 2, minimumFractionDigits: 0,
  }).format(v);
}
