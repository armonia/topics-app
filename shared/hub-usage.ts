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

export interface HubUsage {
  days: HubUsageDays;
  /** Local midnight of the first day of the window. */
  sinceMs: number;
  at: number;
  unit: "hour" | "day";
  /** Start of every bucket, ms epoch, local time. */
  buckets: number[];
  totals: { tokens: number; listUsd: number; requests: number };
  /** Most tokens first. */
  models: HubUsageSlice[];
  accounts: HubUsageSlice[];
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
