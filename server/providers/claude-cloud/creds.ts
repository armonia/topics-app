// Credentials for the sessions API: the OAuth token of the account logged into Claude Code
// (Keychain) or, with `account`, that of a vdm account, which vdm renews by itself.
// Re-read on every call because the token rotates; never printed.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cloudApiIsReal, type CloudCredentials } from "./api";
import { runBounded } from "../../lib/bounded-spawn";

interface OAuthBlob {
  accessToken: string;
}

async function keychainOAuth(): Promise<OAuthBlob> {
  if (process.env.TOPICS_CREDENTIALS_KEYCHAIN === "0") throw new Error("Portachiavi spento per questo processo (TOPICS_CREDENTIALS_KEYCHAIN=0)");
  const r = await runBounded(["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"], { stdout: "pipe", stderr: "ignore", timeoutMs: 10_000 });
  if (r.exitCode !== 0) throw new Error("voce «Claude Code-credentials» assente nel Portachiavi");
  return JSON.parse(r.stdout).claudeAiOauth as OAuthBlob;
}

function accountOAuth(account: string): OAuthBlob {
  const p = join(homedir(), ".claude/account-switcher/accounts", `${account}.json`);
  return JSON.parse(readFileSync(p, "utf8")).claudeAiOauth as OAuthBlob;
}

const orgCache = new Map<string, string>();

async function orgFor(account: string | undefined, token: string): Promise<string> {
  // The Keychain login is read fresh every call, and so is its org: cached, a login
  // switched to another account sent the new token with the old org (30/10/2026).
  if (!account) return JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8")).oauthAccount.organizationUuid;
  const hit = orgCache.get(account);
  if (hit) return hit;
  // ~/.claude.json only describes the logged-in account: for the others the org comes from the profile.
  const res = await fetch("https://api.anthropic.com/api/oauth/profile", {
    headers: { Authorization: `Bearer ${token}`, "anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`profilo ${account}: ${res.status}`);
  const org = ((await res.json()) as { organization: { uuid: string } }).organization.uuid;
  orgCache.set(account, org);
  return org;
}

export function credentialsFor(account?: string): () => Promise<CloudCredentials> {
  return async () => {
    // A fake API (e2e) never sees the real token.
    if (!cloudApiIsReal()) return { accessToken: "e2e-fake", orgUuid: "e2e-fake" };
    const { accessToken } = account ? accountOAuth(account) : await keychainOAuth();
    return { accessToken, orgUuid: await orgFor(account, accessToken) };
  };
}
