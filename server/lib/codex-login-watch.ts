// codex-login-watch.ts — lets a Codex wall end when the person logs in as
// someone else.
//
// The Codex hold (`provider-hold.ts`, key "codex") is written from the sentence
// inside the CLI's own error ("try again at ...") and has no usage endpoint to
// re-read, unlike Claude's, which `scheduleHoldRecheck` re-reads every tick. So
// after `codex login` with another account the hold of the OLD account stayed
// in force until its published end, days away, and every chat and group guest
// on Codex sat unanswered behind a wall that no longer applied.
//
// The answer is the identity the CLI is logged in as, read from `auth.json`:
// remembered when the hold is set, compared on the recheck tick, and the hold
// lifted when it changed. The identity is the account, never the file bytes:
// the CLI rewrites `auth.json` on every token renewal, and that is no login.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { clearProviderHold, providerHold } from "./provider-hold";

const CODEX_KEY = "codex";

/** Where the Codex CLI keeps its login, by the same rule `providers/codex.ts` follows. */
export function codexAuthPath(): string {
  return join(process.env.CODEX_HOME || join(process.env.HOME || process.env.USERPROFILE || "", ".codex"), "auth.json");
}

function claimsOf(idToken: unknown): string {
  if (typeof idToken !== "string") return "";
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8")) as { sub?: unknown };
    return typeof payload.sub === "string" ? payload.sub : "";
  } catch {
    return "";
  }
}

/**
 * Who the CLI is logged in as, as an opaque string, or null when no login can
 * be read (no file, not JSON, no identity in it). Never the token itself.
 */
export function codexLoginIdentity(path: string = codexAuthPath()): string | null {
  try {
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      OPENAI_API_KEY?: unknown;
      tokens?: { account_id?: unknown; id_token?: unknown };
    };
    const account = typeof raw.tokens?.account_id === "string" ? raw.tokens.account_id : "";
    const subject = claimsOf(raw.tokens?.id_token);
    const apiKey = typeof raw.OPENAI_API_KEY === "string" && raw.OPENAI_API_KEY ? raw.OPENAI_API_KEY : "";
    if (!account && !subject && !apiKey) return null;
    return createHash("sha256").update(`${account}|${subject}|${apiKey}`).digest("hex");
  } catch {
    return null;
  }
}

/** The identity the hold in force was set under; null when none is known. */
let heldUnder: string | null = null;

/** Called when a Codex hold is recorded: remember whose wall it is. */
export function rememberCodexHoldLogin(path: string = codexAuthPath()): void {
  heldUnder = codexLoginIdentity(path);
}

/**
 * Lift the Codex hold if the CLI is now logged in as somebody else than when it
 * was set. A hold restored from disk after a restart has no remembered login:
 * the current one is taken as the baseline, so a restart never lifts a wall by
 * itself. Returns whether the hold was lifted.
 */
export function releaseCodexHoldIfLoginChanged(nowMs: number = Date.now(), path: string = codexAuthPath()): boolean {
  if (!providerHold(nowMs, CODEX_KEY)) { heldUnder = null; return false; }
  const current = codexLoginIdentity(path);
  if (!current) return false;
  if (heldUnder == null) { heldUnder = current; return false; }
  if (current === heldUnder) return false;
  heldUnder = null;
  clearProviderHold(CODEX_KEY);
  return true;
}

/** @internal Tests only: forget the remembered login. */
export function resetCodexLoginWatch(): void {
  heldUnder = null;
}
