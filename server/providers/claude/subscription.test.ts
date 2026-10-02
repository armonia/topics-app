/**
 * THE PLAN LEAVES THE SERVER, THE CREDENTIAL DOES NOT.
 *
 * The two labels live in the same JSON as the access and refresh tokens. These
 * tests feed the real shape of that document (a file under a throwaway HOME,
 * read by the same `readCredentials` the runtime uses) and check that what
 * comes out is the two labels and nothing that looks like a token.
 *
 * @covers USERMENU-10
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readClaudeSubscription, subscriptionFrom } from "./subscription";

const ACCESS = "sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; // allow-secret: a made-up token, the fixture the test looks for
const REFRESH = "sk-ant-ort01-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"; // allow-secret: a made-up token, the fixture the test looks for

/** Anything a credential is made of: the token prefix, or a long opaque run. */
function looksLikeASecret(json: string): boolean {
  return /sk-ant|oat01|ort01/.test(json) || /[A-Za-z0-9_-]{49,}/.test(json);
}

describe("subscriptionFrom", () => {
  test("keeps the two labels and drops everything else", () => {
    const out = subscriptionFrom({
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_20x",
      ...({ accessToken: ACCESS, refreshToken: REFRESH, scopes: ["user:inference"] } as object),
    });
    expect(out).toEqual({ type: "max", tier: "default_claude_max_20x" });
    expect(Object.keys(out ?? {}).sort()).toEqual(["tier", "type"]);
    expect(looksLikeASecret(JSON.stringify(out))).toBe(false);
  });

  test("a value that is not a short label is not passed on, even under the right name", () => {
    expect(subscriptionFrom({ subscriptionType: ACCESS, rateLimitTier: REFRESH })).toBeNull();
    expect(subscriptionFrom({ subscriptionType: "pro", rateLimitTier: "a b" })).toEqual({ type: "pro", tier: null });
    expect(subscriptionFrom({ subscriptionType: 42, rateLimitTier: { x: 1 } })).toBeNull();
  });

  test("nothing known is null, not an empty object", () => {
    expect(subscriptionFrom(null)).toBeNull();
    expect(subscriptionFrom({})).toBeNull();
  });
});

describe("readClaudeSubscription, from the credentials file the CLI writes", () => {
  const saved = { home: process.env.HOME, keychain: process.env.TOPICS_CREDENTIALS_KEYCHAIN };
  let home = "";

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "topics-subscription-"));
    mkdirSync(join(home, ".claude"), { recursive: true });
    process.env.HOME = home;
    process.env.TOPICS_CREDENTIALS_KEYCHAIN = "0";
  });

  afterEach(() => {
    if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
    if (saved.keychain === undefined) delete process.env.TOPICS_CREDENTIALS_KEYCHAIN;
    else process.env.TOPICS_CREDENTIALS_KEYCHAIN = saved.keychain;
  });

  test("the whole document goes in, only the two labels come out", () => {
    writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({
      claudeAiOauth: {
        accessToken: ACCESS,
        refreshToken: REFRESH,
        expiresAt: Date.now() + 3_600_000,
        scopes: ["user:inference", "user:profile"],
        subscriptionType: "max",
        rateLimitTier: "default_claude_max_5x",
      },
      mcpOAuth: { someServer: { accessToken: ACCESS } },
    }));
    const out = readClaudeSubscription();
    expect(out).toEqual({ type: "max", tier: "default_claude_max_5x" });
    expect(looksLikeASecret(JSON.stringify(out))).toBe(false);
  });

  test("no credentials on this machine: null", () => {
    expect(readClaudeSubscription()).toBeNull();
  });
});
