/**
 * The Claude proxy's rows summed into the shape the Dashboard draws
 * (`shared/hub-usage.ts`, HUBBR-12). Pure: the route fetches, this adds up.
 *
 * Windows start at LOCAL midnight: «Oggi» is today, not the last 24 hours,
 * and a week is today plus the six days before, as the board's own numbers.
 */
import { calculateCostWithCache } from "./pricing";
import { costTokens } from "../../shared/token-cost";
import { PROXY_ROW_CAP, type HubUsage, type HubUsageDays, type HubUsageSlice } from "../../shared/hub-usage";

const HOUR_MS = 3_600_000;

interface ProxyRow {
  ts: number;
  model: string;
  account: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

function readRow(raw: unknown): ProxyRow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.ts !== "number" || !Number.isFinite(r.ts)) return null;
  return {
    ts: r.ts,
    model: typeof r.model === "string" && r.model ? r.model : "unknown",
    account: typeof r.account === "string" && r.account ? r.account : "unknown",
    inputTokens: num(r.inputTokens),
    outputTokens: num(r.outputTokens),
    cacheReadTokens: num(r.cacheReadTokens),
    cacheCreationTokens: num(r.cacheCreationTokens),
  };
}

/** Local midnight `daysBack` days before the day of `now`. */
export function localMidnight(now: number, daysBack = 0): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysBack);
  return d.getTime();
}

/** The window's first instant and its buckets: hours for today, days otherwise. */
export function usageBuckets(days: HubUsageDays, now: number): { sinceMs: number; unit: "hour" | "day"; buckets: number[] } {
  const sinceMs = localMidnight(now, days - 1);
  if (days === 1) {
    const hours = Math.floor((now - sinceMs) / HOUR_MS) + 1;
    return { sinceMs, unit: "hour", buckets: Array.from({ length: Math.min(24, Math.max(1, hours)) }, (_, i) => sinceMs + i * HOUR_MS) };
  }
  return { sinceMs, unit: "day", buckets: Array.from({ length: days }, (_, i) => localMidnight(now, days - 1 - i)) };
}

function bucketIndex(ts: number, buckets: number[]): number {
  for (let i = buckets.length - 1; i >= 0; i--) if (ts >= buckets[i]!) return i;
  return -1;
}

function add(map: Map<string, HubUsageSlice>, key: string, tokens: number, usd: number): void {
  const slice = map.get(key) ?? { key, tokens: 0, listUsd: 0, requests: 0 };
  slice.tokens += tokens;
  slice.listUsd += usd;
  slice.requests += 1;
  map.set(key, slice);
}

const byTokens = (a: HubUsageSlice, b: HubUsageSlice) => b.tokens - a.tokens || a.key.localeCompare(b.key);

export function aggregateProxyUsage(rawRows: unknown[], days: HubUsageDays, now: number): HubUsage {
  const { sinceMs, unit, buckets } = usageBuckets(days, now);
  const models = new Map<string, HubUsageSlice>();
  const accounts = new Map<string, HubUsageSlice>();
  const perModel = new Map<string, { tokens: number[]; listUsd: number[] }>();
  const totals = { tokens: 0, listUsd: 0, requests: 0 };
  let oldest = Infinity;
  for (const raw of rawRows) {
    const row = readRow(raw);
    if (!row) continue;
    if (row.ts < oldest) oldest = row.ts;
    if (row.ts < sinceMs || row.ts > now) continue;
    const tokens = costTokens({ billable: row.inputTokens + row.outputTokens + row.cacheCreationTokens, cacheRead: row.cacheReadTokens });
    const usd = calculateCostWithCache({
      model: row.model,
      freshInputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheCreationTokens: row.cacheCreationTokens,
    });
    totals.tokens += tokens;
    totals.listUsd += usd;
    totals.requests += 1;
    add(models, row.model, tokens, usd);
    add(accounts, row.account, tokens, usd);
    const i = bucketIndex(row.ts, buckets);
    if (i < 0) continue;
    const s = perModel.get(row.model) ?? { tokens: buckets.map(() => 0), listUsd: buckets.map(() => 0) };
    s.tokens[i]! += tokens;
    s.listUsd[i]! += usd;
    perModel.set(row.model, s);
  }
  const modelList = [...models.values()].sort(byTokens);
  const fromMs = Number.isFinite(oldest) ? oldest : null;
  return {
    days,
    sinceMs,
    at: now,
    unit,
    buckets,
    totals,
    models: modelList,
    accounts: [...accounts.values()].sort(byTokens),
    series: modelList.map((m) => ({ model: m.key, ...(perModel.get(m.key) ?? { tokens: buckets.map(() => 0), listUsd: buckets.map(() => 0) }) })),
    // A full history whose oldest row is inside the window: what came before was dropped by the proxy.
    coverage: { partial: rawRows.length >= PROXY_ROW_CAP && fromMs !== null && fromMs > sinceMs, fromMs },
  };
}
