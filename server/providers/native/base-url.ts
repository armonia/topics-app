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
