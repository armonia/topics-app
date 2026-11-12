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

/** Switchboard's dashboard, where the account engine keeps its settings (same env as the hub bridge, `routes/hub.ts`). */
const SWITCHBOARD_DASHBOARD_URL = "http://127.0.0.1:3335";
/** The engine's own ceiling on a hold (`MAX_HOLD_MIN` in Switchboard): 24 h. */
const ENGINE_HOLD_CEILING_MS = 24 * 60 * 60_000;
const ENGINE_SETTINGS_TIMEOUT_MS = 3_000;

/**
 * How long the account engine behind the base URL may keep a request without
 * answering, by design: with every account capped or rate-limited it parks the
 * request for up to `usageCapHoldMin` minutes before any header, then answers
 * or says 429. 0 when the base URL is Anthropic's own, when the engine holds
 * nothing, or when its settings cannot be read within 3 s (a silent engine is
 * not holding anything worth waiting for).
 */
export async function engineHoldMs(): Promise<number> {
  if (anthropicBaseUrl() === DEFAULT_ANTHROPIC_BASE_URL) return 0;
  if (process.env.TOPICS_E2E === "1" && !process.env.TOPICS_SWITCHBOARD_URL) return 0;
  const base = (process.env.TOPICS_SWITCHBOARD_URL?.trim() || SWITCHBOARD_DASHBOARD_URL).replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/api/settings`, { signal: AbortSignal.timeout(ENGINE_SETTINGS_TIMEOUT_MS) });
    if (!res.ok) return 0;
    const minutes = Number((await res.json() as { usageCapHoldMin?: unknown }).usageCapHoldMin);
    return Number.isFinite(minutes) && minutes > 0 ? Math.min(minutes * 60_000, ENGINE_HOLD_CEILING_MS) : 0;
  } catch {
    return 0;
  }
}
