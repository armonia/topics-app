/**
 * Codex quota hold: lifted when the CLI logs in with a different account.
 *
 * @covers RESUME-04
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearProviderHold, providerHold, setProviderHold } from "./provider-hold";
import { codexLoginIdentity, releaseCodexHoldIfLoginChanged, rememberCodexHoldLogin, resetCodexLoginWatch } from "./codex-login-watch";

const NOW = Date.parse("2026-11-16T12:00:00Z");
const UNTIL = Date.parse("2026-11-22T12:00:00Z");

let dir: string;
let authPath: string;

function login(accountId: string, refresh = "r1"): void {
  writeFileSync(authPath, JSON.stringify({ tokens: { account_id: accountId, refresh_token: refresh, access_token: "a" } }));
}

function hold(): void {
  setProviderHold({ untilMs: UNTIL, window: "usage_limit", reason: "Codex plan usage limit reached", provider: "codex" }, NOW);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codex-login-"));
  authPath = join(dir, "auth.json");
  resetCodexLoginWatch();
  clearProviderHold("codex");
});

afterEach(() => {
  clearProviderHold("codex");
  resetCodexLoginWatch();
  rmSync(dir, { recursive: true, force: true });
});

describe("codex login watch", () => {
  test("a different account lifts the hold", () => {
    login("acct-old");
    hold();
    rememberCodexHoldLogin(authPath);
    login("acct-new");
    expect(releaseCodexHoldIfLoginChanged(NOW + 1000, authPath)).toBe(true);
    expect(providerHold(NOW + 1000, "codex")).toBeNull();
  });

  test("a token renewal for the same account keeps the hold", () => {
    login("acct-old", "r1");
    hold();
    rememberCodexHoldLogin(authPath);
    login("acct-old", "r2");
    expect(releaseCodexHoldIfLoginChanged(NOW + 1000, authPath)).toBe(false);
    expect(providerHold(NOW + 1000, "codex")).not.toBeNull();
  });

  test("a hold with no remembered login adopts the current one and stays", () => {
    login("acct-old");
    hold();
    expect(releaseCodexHoldIfLoginChanged(NOW + 1000, authPath)).toBe(false);
    login("acct-new");
    expect(releaseCodexHoldIfLoginChanged(NOW + 2000, authPath)).toBe(true);
  });

  test("an unreadable login never lifts anything", () => {
    login("acct-old");
    hold();
    rememberCodexHoldLogin(authPath);
    writeFileSync(authPath, "not json");
    expect(codexLoginIdentity(authPath)).toBeNull();
    expect(releaseCodexHoldIfLoginChanged(NOW + 1000, authPath)).toBe(false);
    expect(providerHold(NOW + 1000, "codex")).not.toBeNull();
  });
});
