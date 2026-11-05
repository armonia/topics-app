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
 *   /api/hub/projects           the tokens Muse took off Claude this week
 *
 * The saving against the list price is Claude's only: the proxy sees only
 * Claude, and a Codex or Muse figure would be a guess written as a number.
 * Pure on purpose: the wire shapes are the part that can be wrong in silence.
 */
import { HUB_USAGE_DAYS, type HubUsage, type HubUsageDays, type HubUsageSlice } from '../../../shared/hub-usage';
import { readProxyAccounts, type QuotaWindow } from './accountQuotas';

export { HUB_USAGE_DAYS };
export type { HubUsage, HubUsageDays };

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
  return raw as unknown as HubUsage;
}

/**
 * The list price of a Claude plan in dollars a month, from the proxy's
 * subscription and tier: Max 20x 200, Max 5x 100, Pro 20. Null for a plan
 * whose price is not known here: it is said apart, never counted as free.
 */
export function planPriceUsd(sub: unknown, tier: unknown): number | null {
  const s = String(sub ?? '').toLowerCase();
  const t = String(tier ?? '').toLowerCase();
  if (s === 'max' || t.includes('max')) return /20x/.test(t) ? 200 : 100;
  if (s === 'pro' || t.includes('pro')) return 20;
  return null;
}

export interface Paid {
  /** What the Claude plans cost for the window, in dollars. */
  usd: number;
  plans: number;
  /** Plans the proxy lists whose price is not known here. */
  unpriced: number;
}

/** The Claude plans of the proxy, their monthly price spread over the window's days. */
export function paidForWindow(profiles: unknown, days: HubUsageDays): Paid | null {
  if (!isObject(profiles) || !Array.isArray(profiles.profiles)) return null;
  let usd = 0;
  let plans = 0;
  let unpriced = 0;
  for (const p of profiles.profiles) {
    if (!isObject(p)) continue;
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
export function usdEurOf(settings: unknown): number {
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
  /** Share of the week, Claude + Codex + Muse, in %. */
  total: number;
  claude: number;
  codex: number;
  muse: number;
  /** The cap you set, in % of the week; null when there is none. */
  budgetPct: number | null;
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
    out.push({
      name,
      title: str(p.label) ?? str(p.title) ?? name,
      total,
      claude: num(p.claude) ?? 0,
      codex: num(p.codex) ?? 0,
      muse: num(p.muse) ?? 0,
      budgetPct,
      over: budgetPct !== null && total > budgetPct,
    });
  }
  return out.sort((a, b) => b.total - a.total || a.title.localeCompare(b.title));
}

/** The first rows as they are and the rest summed: «altri N». */
export function headAndRest(rows: ProjectShare[], keep = 4): { head: ProjectShare[]; rest: { count: number; total: number } | null } {
  const tail = rows.slice(keep);
  return { head: rows.slice(0, keep), rest: tail.length ? { count: tail.length, total: tail.reduce((s, r) => s + r.total, 0) } : null };
}

/**
 * The decision that is yours: the project furthest past the cap you set, with
 * the cap ten points higher as the one-click raise (never past 100).
 */
export function overCap(rows: ProjectShare[]): { project: ProjectShare; raiseTo: number } | null {
  const over = rows.filter((r) => r.over && r.budgetPct !== null).sort((a, b) => (b.total - (b.budgetPct ?? 0)) - (a.total - (a.budgetPct ?? 0)))[0];
  if (!over || over.budgetPct === null) return null;
  const raiseTo = Math.min(100, Math.max(Math.ceil(over.total / 5) * 5, over.budgetPct + 10));
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
  fiveH: QuotaWindow | null;
  week: QuotaWindow | null;
  /** Share of the window's Claude tokens through this account, in %; null when it carried none. */
  share: number | null;
}

/** The proxy's Claude accounts with their windows and their part of the window's tokens. */
export function accountShares(profiles: unknown, usage: HubUsage | null, now = Date.now()): AccountShare[] {
  const proxy = readProxyAccounts(profiles, now);
  if (!proxy) return [];
  return proxy.accounts.map((a) => {
    const slice = usage?.accounts.find((s) => s.key === a.label || s.key === a.name);
    return {
      label: a.label,
      inUse: a.active,
      disabled: a.disabled,
      fiveH: a.fiveH,
      week: a.week,
      share: slice && usage ? sharePct(slice, usage) : null,
    };
  });
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
export function euro(usd: number, usdEur: number, locale: string): string {
  const v = usd * usdEur;
  return new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-US', {
    style: 'currency', currency: 'EUR', maximumFractionDigits: Math.abs(v) >= 100 ? 0 : 2, minimumFractionDigits: 0,
  }).format(v);
}
