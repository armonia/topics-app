// usage-window.ts — the plan's usage windows, read from the same endpoint the
// Claude CLI's `/usage` reads, and what a 429 means in their light.
//
// A 429 from the API says "would exceed your account's rate limit" for two
// very different walls: a per-minute limit that frees in seconds (worth the
// retry loop in `retry.ts`) and an exhausted usage window that frees at a
// published time, hours away (worth NOTHING but waiting for that time). The
// message does not tell them apart; the usage endpoint does.

import { setProviderHold, clearProviderHold, providerHold, recordPlanUsage, type UsageWindowKind } from "../../lib/provider-hold";
import { recoverAfter401 } from "./auth";
import type { PlanUsage, PlanUsageWindow } from "../../../shared/provider-hold";

export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

// The endpoint and the CLI event describe the same two windows, so they share
// one declaration (`shared/provider-hold.ts`). These aliases keep the local
// names this module and its callers already use.
export type UsageWindow = PlanUsageWindow;
export type Usage = Omit<PlanUsage, "observedAtMs">;

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
  const latest = spent.reduce((a, b) => (a.w!.resetsAtMs! >= b.w!.resetsAtMs! ? a : b));
  return { untilMs: latest.w!.resetsAtMs!, window: latest.window, reason: latest.reason };
}

/**
 * A fresh reading of the windows, from whichever source produced it: the
 * endpoint below or the CLI's `rate_limit_event`. It records the percentage for
 * the status bar and the dispatcher, and then asks the ONE question the hold
 * already knows how to answer, so a window read as spent walks into the same
 * wait whether the number came from the CLI or from the endpoint.
 */
export function observePlanUsage(usage: Usage | null, nowMs: number = Date.now()): void {
  if (!usage) return;
  recordPlanUsage(usage, nowMs);
  const hold = holdFromUsage(usage, nowMs);
  if (!hold) return;
  // The very wall the engine just said it rotates past (same window, a reset
  // no later) is not set again on the CLI's word alone (see
  // `ENGINE_LIFT_TRUST_MS`): the engine is asked again, and the wall goes up
  // if it no longer has a free account. Any other wall is set at once.
  const lift = engineLift;
  if (lift && nowMs - lift.atMs < ENGINE_LIFT_TRUST_MS && hold.window === lift.window && hold.untilMs <= lift.untilMs) {
    // Only for the lift it was asked about: a later lift (the engine free
    // again) makes this answer stale.
    void lift.probe()
      .then((free) => { if (free !== true && engineLift === lift) setProviderHold(hold, nowMs); })
      .catch(() => { if (engineLift === lift) setProviderHold(hold, nowMs); });
    return;
  }
  setProviderHold(hold, nowMs);
}

/** Read the windows with the session's OAuth token. Never throws: a usage
 *  endpoint that is down must not decide anything. */
export async function fetchUsage(
  token: string,
  fetchImpl: typeof fetch = fetch,
  recover: (stale: string) => Promise<string | null> = recoverAfter401,
): Promise<Usage | null> {
  const read = (t: string) => fetchImpl(USAGE_URL, {
    headers: { Authorization: `Bearer ${t}`, "anthropic-beta": "oauth-2025-04-20" },
    signal: AbortSignal.timeout(10_000),
  });
  try {
    let res = await read(token);
    // An expired or revoked token (the CLI rotated the pair) is one re-read or
    // renewal away from working: retry once with the recovered token.
    if (res.status === 401) {
      const fresh = await recover(token);
      if (!fresh) {
        console.warn("[usage] the OAuth token is expired and could not be renewed: the plan usage is unreadable until a new /login");
        return null;
      }
      res = await read(fresh);
    }
    if (!res.ok) {
      console.warn(`[usage] the usage endpoint answered ${res.status}: the plan usage is unreadable`);
      return null;
    }
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
  recordPlanUsage(usage, nowMs);
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
  const hold = providerHold(nowMs);
  // An API outage is no spent window, and the usage endpoint answering says
  // nothing about the path the CLI's requests take: an answer lifts it (a
  // child's stream in `claude/api-outage.ts`, a native round), or its horizon.
  if (!hold || hold.window === "api-down") return false;
  const usage = await fetchUsage(token, fetchImpl);
  if (!usage) return false;
  recordPlanUsage(usage, nowMs);
  if (holdFromUsage(usage, nowMs)) return false;
  clearProviderHold();
  return true;
}

/**
 * A plan hold lifted because the account engine behind the base URL still has
 * an account that can take requests (`engineHasFreeAccount`, `base-url.ts`). The hold
 * measures one account's windows, the engine rotates past it: a spent account
 * is no wall while another one is free. An API outage hold is not the
 * engine's to lift, and an engine that cannot be read decides nothing.
 *
 * Only the hold that was asked about is lifted: one set while the engine was
 * being read (a real 429, `saturationHold`) is newer than the answer.
 */
export async function releaseHoldIfEngineFree(engineFree: () => Promise<boolean | null>, nowMs: number = Date.now()): Promise<boolean> {
  const hold = providerHold(nowMs);
  if (!hold || hold.window === "api-down") return false;
  if ((await engineFree()) !== true) return false;
  if (providerHold(nowMs)?.sinceMs !== hold.sinceMs) return false;
  clearProviderHold();
  engineLift = { window: hold.window, untilMs: hold.untilMs, atMs: nowMs, probe: engineFree };
  return true;
}

/**
 * How long an engine lift keeps the CLI's own readings from setting the same
 * wall again. The CLI reports the windows of the account that served its
 * turn: right after a lift, an account at 99% would re-arm the hold on its
 * next turn and the banner, the dispatcher and the resume sweep would flap.
 * A real 429 (`saturationHold`) is not stopped by this.
 */
export const ENGINE_LIFT_TRUST_MS = 10 * 60_000;
let engineLift: { window: UsageWindowKind; untilMs: number; atMs: number; probe: () => Promise<boolean | null> } | null = null;

/** @internal Tests only: forget the last engine lift. */
export function resetEngineLift(): void {
  engineLift = null;
}
