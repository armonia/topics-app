// Credenziali per l'API delle sessioni: il token OAuth dell'account loggato in Claude Code
// (Portachiavi) o, con `account`, quello di un account di vdm, che vdm rinnova da solo.
// Si rilegge a ogni chiamata perché il token ruota; non si stampa mai.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cloudApiIsReal, type CloudCreds } from "./api";
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
  const key = account ?? "";
  const hit = orgCache.get(key);
  if (hit) return hit;
  let org: string;
  if (!account) {
    org = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8")).oauthAccount.organizationUuid;
  } else {
    // ~/.claude.json descrive solo l'account loggato: per gli altri l'org la dice il profilo.
    const res = await fetch("https://api.anthropic.com/api/oauth/profile", {
      headers: { Authorization: `Bearer ${token}`, "anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`profilo ${account}: ${res.status}`);
    org = ((await res.json()) as { organization: { uuid: string } }).organization.uuid;
  }
  orgCache.set(key, org);
  return org;
}

export function credsFor(account?: string): () => Promise<CloudCreds> {
  return async () => {
    // A fake API (e2e) never sees the real token.
    if (!cloudApiIsReal()) return { accessToken: "e2e-fake", orgUuid: "e2e-fake" };
    const { accessToken } = account ? accountOAuth(account) : await keychainOAuth();
    return { accessToken, orgUuid: await orgFor(account, accessToken) };
  };
}
