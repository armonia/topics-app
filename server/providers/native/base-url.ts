/**
 * WHERE THE ENGINE SENDS ITS REQUESTS (MSEL-11).
 *
 * Una sessione Claude Code lanciata da Topics legge l'`env` di
 * `~/.claude/settings.json` (`--setting-sources user,project,local`,
 * `claude/args.ts`): se li' c'e' `ANTHROPIC_BASE_URL`, passa da quell'indirizzo
 * (su questa macchina il cambia-account, che ruota gli account su 429/401).
 * Il motore prima andava sempre diretto su api.anthropic.com con un account
 * solo. Qui legge lo stesso indirizzo, nello stesso ordine della CLI:
 *   1. la variabile di processo `ANTHROPIC_BASE_URL`;
 *   2. `env.ANTHROPIC_BASE_URL` di `$HOME/.claude/settings.json`;
 *   3. https://api.anthropic.com.
 *
 * Nessun ripiego silenzioso: se l'indirizzo non risponde, l'errore lo nomina
 * (`agent-loop.ts`), non si riprova in diretta.
 */
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";

function fromSettings(): string | undefined {
  // `HOME` prima di `homedir()`: su macOS il secondo ignora `HOME` (auth.ts).
  const home = process.env.HOME || homedir();
  try {
    const parsed = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")) as {
      env?: Record<string, unknown>;
    };
    const value = parsed?.env?.ANTHROPIC_BASE_URL;
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  } catch {
    // File assente o illeggibile: la CLI fa lo stesso, passa al default.
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
