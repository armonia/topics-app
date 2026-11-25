/**
 * The latest quota reading per account, straight from the quota history file
 * (`history.jsonl`) the account reader writes. One source: the hub's pacing
 * and this view both end up on the same last sample, so a percentage shown
 * here is the percentage `usage-hub pace` prints (card 7526e05d).
 */
import { readHistory, usageHistoryFile, type QuotaHistorySample } from "./person-usage";

export interface QuotaReading {
  provider: string;
  account: string;
  /** Last 7-day and 5-hour % and the second (epoch) each was read; null when never read. */
  week: { pct: number; t: number } | null;
  fiveH: { pct: number; t: number } | null;
}

/** Last sample of every `provider|account|7d|5h` key; later lines win, whatever the file order. */
export function latestReadings(samples: QuotaHistorySample[]): QuotaReading[] {
  const by = new Map<string, QuotaReading>();
  for (const l of samples) {
    for (const [k, v] of Object.entries(l.s ?? {})) {
      const [provider, account, win] = k.split("|");
      if (!provider || !account || !Number.isFinite(v) || (win !== "7d" && win !== "5h")) continue;
      const row = by.get(`${provider}|${account}`) ?? { provider, account, week: null, fiveH: null };
      by.set(`${provider}|${account}`, row);
      const slot = win === "7d" ? "week" : "fiveH";
      if (!row[slot] || l.t >= row[slot]!.t) row[slot] = { pct: v, t: l.t };
    }
  }
  return [...by.values()];
}

/** Null when the history file is missing (no hub on this machine): the caller falls back to the proxy. */
export function readQuotaReadings(file = usageHistoryFile()): QuotaReading[] | null {
  const samples = readHistory(file);
  return samples ? latestReadings(samples) : null;
}
