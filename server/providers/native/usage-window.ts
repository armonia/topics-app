// usage-window.ts — the plan's usage windows, read from the same endpoint the
// Claude CLI's `/usage` reads, and what a 429 means in their light.
//
// A 429 from the API says "would exceed your account's rate limit" for two
// very different walls: a per-minute limit that frees in seconds (worth the
// retry loop in `retry.ts`) and an exhausted usage window that frees at a
// published time, hours away (worth NOTHING but waiting for that time). The
// message does not tell them apart; the usage endpoint does.

import { setProviderHold, clearProviderHold, providerHold, type UsageWindowKind } from "../../lib/provider-hold";

export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

export interface UsageWindow {
  /** Percent of the window already used, 0-100. */
  utilization: number;
  /** When the window resets (ms epoch), when the API says so. */
  resetsAtMs: number | null;
}

export interface Usage {
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
}

/** A window is spent when the next request would not fit. The API reports
 *  utilization rounded, so 100 is "at the wall" and a hair below still is. */
export const EXHAUSTED_AT = 99;

function readWindow(raw: unknown): UsageWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { utilization?: unknown; resets_at?: unknown };
  if (typeof r.utilization !== "number") return null;
  const t = typeof r.resets_at === "string" ? Date.parse(r.resets_at) : NaN;
  return { utilization: r.utilization, resetsAtMs: Number.isFinite(t) ? t : null };
}

/** The two windows out of the endpoint's JSON; anything unreadable is null. */
export function parseUsage(json: unknown): Usage {
  const j = (json && typeof json === "object" ? json : {}) as { five_hour?: unknown; seven_day?: unknown };
  return { fiveHour: readWindow(j.five_hour), sevenDay: readWindow(j.seven_day) };
}

/**
 * The hold a 429 deserves given the windows, or null when neither is spent:
 * then the 429 is the per-minute kind and the retry loop handles it.
 *
 * The longer wall wins: a spent week is not helped by a five-hour reset.
 */
export function holdFromUsage(usage: Usage, nowMs: number): { untilMs: number; window: UsageWindowKind; reason: string } | null {
  const spent = [
    { w: usage.sevenDay, window: "seven_day" as const, reason: "finestra settimanale del piano esaurita" },
    { w: usage.fiveHour, window: "five_hour" as const, reason: "finestra di 5 ore del piano esaurita" },
  ].filter((c) => c.w && c.w.utilization >= EXHAUSTED_AT && c.w.resetsAtMs != null && c.w.resetsAtMs > nowMs);
  if (spent.length === 0) return null;
  const longest = spent.reduce((a, b) => (a.w!.resetsAtMs! >= b.w!.resetsAtMs! ? a : b));
  return { untilMs: longest.w!.resetsAtMs!, window: longest.window, reason: longest.reason };
}

/** Read the windows with the session's OAuth token. Never throws: a usage
 *  endpoint that is down must not decide anything. */
export async function fetchUsage(token: string, fetchImpl: typeof fetch = fetch): Promise<Usage | null> {
  try {
    const res = await fetchImpl(USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return parseUsage(await res.json());
  } catch {
    return null;
  }
}

/**
 * The retry loop's question on a 429: "is there a published end to this?"
 * Answers with the reset time (and records the hold for the whole server)
 * when a window is spent, null otherwise.
 */
export async function saturationHold(token: string, nowMs: number = Date.now(), fetchImpl: typeof fetch = fetch): Promise<number | null> {
  const usage = await fetchUsage(token, fetchImpl);
  if (!usage) return null;
  const hold = holdFromUsage(usage, nowMs);
  if (!hold) return null;
  setProviderHold(hold, nowMs);
  return hold.untilMs;
}

/**
 * A round went through while a hold was in force. That alone does not prove
 * the wall is gone: at the edge of a window small requests pass and large ones
 * do not, and clearing on every success would flap the banner and the
 * dispatcher. So the memo follows the measurement: the windows are re-read,
 * and the hold is lifted only when none is spent any more.
 */
export async function releaseHoldIfFreed(token: string, nowMs: number = Date.now(), fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (!providerHold(nowMs)) return false;
  const usage = await fetchUsage(token, fetchImpl);
  if (!usage) return false;
  if (holdFromUsage(usage, nowMs)) return false;
  clearProviderHold();
  return true;
}
