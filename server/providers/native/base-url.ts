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

/**
 * Until when the account engine behind the base URL is holding requests on
 * purpose, as it says itself: with every account capped or rate-limited it
 * parks a request, before any header, until an account frees up or its hold
 * expires, and logs a `cap-hold` event with that end (`GET /api/proxy-status`,
 * `recentEvents`). Only a hold logged since `sinceMs` (when our request was
 * sent) counts: the setting alone says nothing, since the engine parks only
 * while nothing is selectable, and on 2026-11-11 it was answering everyone else.
 *
 * 0 when the base URL is not on this machine, when the engine logged no such
 * hold, or when it cannot be read within 3 s (a silent engine is not holding
 * anything worth waiting for).
 */
export async function engineHoldUntil(sinceMs: number): Promise<number> {
  let host: string;
  try { host = new URL(anthropicBaseUrl()).hostname; } catch { return 0; }
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]") return 0;
  if (process.env.TOPICS_E2E === "1" && !process.env.TOPICS_SWITCHBOARD_URL) return 0;
  const base = (process.env.TOPICS_SWITCHBOARD_URL?.trim() || SWITCHBOARD_DASHBOARD_URL).replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/api/proxy-status`, { signal: AbortSignal.timeout(ENGINE_STATUS_TIMEOUT_MS) });
    if (!res.ok) return 0;
    const events = (await res.json() as { recentEvents?: unknown }).recentEvents;
    if (!Array.isArray(events)) return 0;
    const now = Date.now();
    let until = 0;
    for (const e of events as Array<{ type?: unknown; ts?: unknown; until?: unknown }>) {
      if (e?.type !== "cap-hold" || typeof e.ts !== "number" || typeof e.until !== "number") continue;
      if (e.ts >= sinceMs - HOLD_CLOCK_SLACK_MS && e.until > now) until = Math.max(until, e.until);
    }
    return until;
  } catch {
    return 0;
  }
}
