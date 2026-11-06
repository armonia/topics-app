/**
 * What the Claude proxy has carried in a window, summed by the Topics server
 * (`GET /api/hub-usage?days=1|7|30`, hub-smistamento HUBBR-12).
 *
 * The proxy answers its raw rows (up to 50 thousand, about 15 MB): summed once
 * on the server, a window sends a few kilobytes instead, phones included.
 * Tokens are the Topics definition (`shared/token-cost.ts`: cache reads weigh
 * a tenth), dollars are the API list price of `shared/model-pricing.ts`.
 */

export const HUB_USAGE_DAYS = [1, 7, 30] as const;
export type HubUsageDays = (typeof HUB_USAGE_DAYS)[number];

/** The proxy keeps this many rows and drops the oldest: a full history means the window may be cut. */
export const PROXY_ROW_CAP = 50_000;

export interface HubUsageSlice {
  /** A model id or an account label, as the proxy wrote it. */
  key: string;
  tokens: number;
  listUsd: number;
  requests: number;
}

export interface HubUsageSeries {
  model: string;
  /** One value per bucket, aligned to `buckets`. */
  tokens: number[];
  listUsd: number[];
}

/** A git folder (the last part of the proxy's `repo`; empty is «no folder») and its branches. */
export interface HubUsageRepo extends HubUsageSlice {
  /** Most tokens first; `key` is the branch, empty when the proxy wrote none. */
  branches: HubUsageSlice[];
}

/** What the window is narrowed to: one model, one account, one folder; null is «all». */
export interface HubUsageFilter {
  model: string | null;
  account: string | null;
  repo: string | null;
}

export interface HubUsage {
  days: HubUsageDays;
  /** Local midnight of the first day of the window. */
  sinceMs: number;
  at: number;
  unit: "hour" | "day";
  /** Start of every bucket, ms epoch, local time. */
  buckets: number[];
  /** `inputTokens` and `outputTokens` are the proxy's own counts, without the cache. */
  totals: { tokens: number; listUsd: number; requests: number; inputTokens: number; outputTokens: number };
  /** Most tokens first. */
  models: HubUsageSlice[];
  accounts: HubUsageSlice[];
  repos: HubUsageRepo[];
  filter: HubUsageFilter;
  /** Every model, account and folder of the window before the filter: what the pickers offer. */
  options: { models: string[]; accounts: string[]; repos: string[] };
  /** Per model, in the order of `models`. */
  series: HubUsageSeries[];
  /** `partial`: the proxy's history is full and does not reach back to `sinceMs`; `fromMs` is its oldest row. */
  coverage: { partial: boolean; fromMs: number | null };
}

/** `days` from a query string; anything else is the week. */
export function parseUsageDays(raw: string | null): HubUsageDays {
  const n = Number(raw);
  return (HUB_USAGE_DAYS as readonly number[]).includes(n) ? (n as HubUsageDays) : 7;
}

/** The folder of a proxy row: the last part of its `repo`, empty when there is none. */
export function repoKey(repo: unknown): string {
  return typeof repo === "string" ? repo.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? "" : "";
}

/** The filter from a query string: an empty or missing value is «all». */
export function parseUsageFilter(params: URLSearchParams): HubUsageFilter {
  const one = (k: string) => {
    const v = params.get(k);
    return v === null || v === "" ? null : v;
  };
  // `repo` may be the empty folder itself: «-» stands for it on the wire.
  const repo = one("repo");
  return { model: one("model"), account: one("account"), repo: repo === "-" ? "" : repo };
}

/** The query string of a filter, the inverse of `parseUsageFilter`. */
export function usageFilterQuery(filter: HubUsageFilter): string {
  const parts: string[] = [];
  if (filter.model !== null) parts.push(`model=${encodeURIComponent(filter.model)}`);
  if (filter.account !== null) parts.push(`account=${encodeURIComponent(filter.account)}`);
  if (filter.repo !== null) parts.push(`repo=${filter.repo === "" ? "-" : encodeURIComponent(filter.repo)}`);
  return parts.map((p) => `&${p}`).join("");
}

export const NO_USAGE_FILTER: HubUsageFilter = { model: null, account: null, repo: null };
