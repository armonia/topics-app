/**
 * WHERE THE ENGINE SENDS ITS REQUESTS (MSEL-11).
 *
 * A Claude Code session launched by Topics reads the `env` of
 * `~/.claude/settings.json` (`--setting-sources user,project,local`,
 * `claude/args.ts`): when `ANTHROPIC_BASE_URL` is there, it goes through that
 * address (on this machine the account switcher, which rotates accounts on a
 * 429 or a 401). The engine used to go straight to api.anthropic.com on one
 * account. It now reads the same address, in the CLI's own order:
 *   1. the process variable `ANTHROPIC_BASE_URL`;
 *   2. `env.ANTHROPIC_BASE_URL` of `$HOME/.claude/settings.json`;
 *   3. https://api.anthropic.com.
 *
 * No silent fallback: when the address does not answer, the error names it
 * (`agent-loop.ts`) and nothing retries against the API directly.
 */
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";

function fromSettings(): string | undefined {
  // `HOME` before `homedir()`: on macOS the latter ignores `HOME` (auth.ts).
  const home = process.env.HOME || homedir();
  try {
    const parsed = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")) as {
      env?: Record<string, unknown>;
    };
    const value = parsed?.env?.ANTHROPIC_BASE_URL;
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  } catch {
    // Missing or unreadable file: the CLI does the same, it moves on to the default.
    return undefined;
  }
}

/** The base URL the Claude Code CLI would use, read fresh at every call. */
export function anthropicBaseUrl(): string {
  const fromEnv = process.env.ANTHROPIC_BASE_URL?.trim();
  return (fromEnv || fromSettings() || DEFAULT_ANTHROPIC_BASE_URL).replace(/\/+$/, "");
}

/** The Messages endpoint on that base URL. */
export function anthropicMessagesUrl(): string {
  return `${anthropicBaseUrl()}/v1/messages`;
}

/** Switchboard's dashboard, where the account engine reports what it is doing (same env as the hub bridge, `routes/hub.ts`). */
const SWITCHBOARD_DASHBOARD_URL = "http://127.0.0.1:3335";
const ENGINE_STATUS_TIMEOUT_MS = 3_000;
/** A hold logged this long before our request was sent still counts: the two clocks are the same, the log is not instant. */
const HOLD_CLOCK_SLACK_MS = 2_000;

type EngineEvent = { type?: unknown; ts?: unknown; until?: unknown };
type EngineProfile = { limited?: unknown; disabled?: unknown; expired?: unknown; cap?: { over?: unknown } | null };

/**
 * One page of the account engine's dashboard, or null when the base URL is
 * not on this machine or the engine cannot be read within 3 s.
 */
async function engineGet(path: string): Promise<Record<string, unknown> | null> {
  let host: string;
  try { host = new URL(anthropicBaseUrl()).hostname; } catch { return null; }
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]") return null;
  if (process.env.TOPICS_E2E === "1" && !process.env.TOPICS_SWITCHBOARD_URL) return null;
  const base = (process.env.TOPICS_SWITCHBOARD_URL?.trim() || SWITCHBOARD_DASHBOARD_URL).replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(ENGINE_STATUS_TIMEOUT_MS) });
    if (!res.ok) return null;
    const json = await res.json() as unknown;
    return json && typeof json === "object" ? json as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * The engine's recent events (`GET /api/proxy-status`, `recentEvents`, the
 * last 20), or null when it cannot be read (a silent engine is not holding
 * anything worth waiting for).
 */
async function engineEvents(): Promise<EngineEvent[] | null> {
  const events = (await engineGet("/api/proxy-status"))?.recentEvents;
  return Array.isArray(events) ? events as EngineEvent[] : null;
}

/**
 * Whether the account engine behind the base URL would pick an account for a
 * request right now. Read from `GET /api/profiles`, the view of the engine's
 * own selector: not limited (a spent window, the engine's threshold), not
 * disabled, not over its cap, not expired. `/api/proxy-status` says
 * `available` for an account at 99% of its week, so it is not asked.
 * null when there is no local engine or it cannot be read.
 *
 * The plan hold is read off ONE account's windows (the token in the Keychain,
 * or the account that served the CLI's last turn), while every request goes
 * through the engine, which rotates past a spent account. On 18/11 one spent
 * week (reset 22/11) held the whole server for four days with another account
 * at 18%: no card dispatched, no sub-agent result woke its parent, and the
 * usage endpoint that should have lifted it answered 429.
 */
export async function engineHasFreeAccount(): Promise<boolean | null> {
  const profiles = (await engineGet("/api/profiles"))?.profiles;
  if (!Array.isArray(profiles) || profiles.length === 0) return null;
  return (profiles as EngineProfile[]).some((p) =>
    p?.limited === false && p.disabled !== true && p.expired !== true && p.cap?.over !== true);
}

/**
 * Until when the account engine behind the base URL is holding requests on
 * purpose, as it says itself: with every account capped or rate-limited it
 * parks a request, before any header, until an account frees up or its hold
 * expires, and logs a `cap-hold` event with that end. Only a hold logged since
 * `sinceMs` (when our request was sent) counts: the setting alone says
 * nothing, since the engine parks only while nothing is selectable, and on
 * 2026-11-11 it was answering everyone else. The event names no request, so a
 * hold logged since then may be another request's: the caller reads it once.
 *
 * The end of the latest such hold, even one already over (the answer may be
 * on its way); 0 when the engine logged no such hold or cannot be read.
 */
export async function engineHoldUntil(sinceMs: number): Promise<number> {
  const events = await engineEvents();
  let until = 0;
  for (const e of events ?? []) {
    if (e?.type !== "cap-hold" || typeof e.ts !== "number" || typeof e.until !== "number") continue;
    if (e.ts >= sinceMs - HOLD_CLOCK_SLACK_MS) until = Math.max(until, e.until);
  }
  return until;
}

/** How fresh a `cap-exhausted` must be to be the verdict behind the 429 we just got. */
const CAP_EXHAUSTED_FRESH_MS = 5_000;

/**
 * Whether the account engine gave up on a hold when it answered us: when a
 * hold expires with no account free it logs `cap-exhausted` and answers that
 * request 429 in the same tick. Only an event in the seconds before
 * `answeredAt` (when our 429 arrived, not when the engine is read) and after
 * `sinceMs` (when our request was sent) counts; a 429 with no such event is a
 * passing limit upstream, not the engine's verdict.
 */
export async function engineJustGaveUp(sinceMs: number, answeredAt: number): Promise<boolean> {
  const events = await engineEvents();
  const from = Math.max(sinceMs, answeredAt - CAP_EXHAUSTED_FRESH_MS) - HOLD_CLOCK_SLACK_MS;
  const to = answeredAt + HOLD_CLOCK_SLACK_MS / 2;
  return (events ?? []).some((e) => e?.type === "cap-exhausted" && typeof e.ts === "number" && e.ts >= from && e.ts <= to);
}
