/**
 * A renewal the disk refused must not lose the rotated refresh token.
 *
 * The refresh token rotates: once the endpoint answers, the one on disk is
 * dead. When the write failed, the new pair was returned once and forgotten,
 * so the next renewal re-read the dead token and the user had to /login.
 * All tokens here are fake; the token endpoint is a stubbed `fetch`.
 * @covers MP-AUTH-01
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as auth from "./auth";

const HOME_VERA = process.env.HOME;
const KEYCHAIN_VERA = process.env.TOPICS_CREDENTIALS_KEYCHAIN;
const realFetch = globalThis.fetch;
const realError = console.error;
const PREVIOUS_TEMP_DIR = process.env.TMPDIR;
let homeDir: string;
let claudeDir: string;
let credentialsPath: string;
let logged: string[];

function writeExpired(accessToken: string, refreshToken: string) {
  writeFileSync(credentialsPath, JSON.stringify({
    claudeAiOauth: { accessToken, refreshToken, expiresAt: Date.now() - 1000 },
  }));
}

/** A token endpoint that rotates: each refresh token works exactly once. */
function rotatingEndpoint(chain: Record<string, { access: string; refresh: string; expiresIn?: number }>) {
  const used = new Set<string>();
  const calls: string[] = [];
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    const sent = JSON.parse(String(init?.body ?? "{}")).refresh_token as string;
    calls.push(sent);
    const next = chain[sent];
    if (!next || used.has(sent)) {
      return new Response('{"error":"invalid_grant"}', { status: 400 });
    }
    used.add(sent);
    return new Response(JSON.stringify({
      access_token: next.access, refresh_token: next.refresh, expires_in: next.expiresIn ?? 28800,
    }), { status: 200 });
  }) as unknown as typeof fetch;
  return calls;
}

/**
 * The write goes through a scratch file under `os.tmpdir()`: pointing TMPDIR
 * at a folder that does not exist makes it fail while the read and the lock,
 * which live next to the credentials, keep working.
 */
function diskRefuses() { process.env.TMPDIR = join(homeDir, "no-such-dir"); }
function diskAccepts() {
  if (PREVIOUS_TEMP_DIR === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = PREVIOUS_TEMP_DIR;
}

describe("a renewal that could not be saved", () => {
  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "auth-unsaved-"));
    claudeDir = join(homeDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    credentialsPath = join(claudeDir, ".credentials.json");
    process.env.HOME = homeDir;
    delete process.env.TOPICS_CREDENTIALS_KEYCHAIN;
    logged = [];
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  });

  afterEach(async () => {
    // A pair a case left in memory is saved here, while its folder exists:
    // the next case must start from the disk alone.
    diskAccepts();
    await auth.getAccessToken().catch(() => null);
    globalThis.fetch = realFetch;
    console.error = realError;
    diskAccepts();
    if (HOME_VERA === undefined) delete process.env.HOME; else process.env.HOME = HOME_VERA;
    if (KEYCHAIN_VERA === undefined) delete process.env.TOPICS_CREDENTIALS_KEYCHAIN;
    else process.env.TOPICS_CREDENTIALS_KEYCHAIN = KEYCHAIN_VERA;
    try { rmSync(homeDir, { recursive: true, force: true }); } catch { /* scratch */ }
  });

  test("keeps the rotated pair in memory, keeps using it, and saves it once the disk accepts", async () => {
    writeExpired("fake-access-1", "fake-refresh-1");
    const calls = rotatingEndpoint({ "fake-refresh-1": { access: "fake-access-2", refresh: "fake-refresh-2" } });
    diskRefuses();

    expect(await auth.getAccessToken()).toBe("fake-access-2");
    // The disk still holds the dead pair; the next call must not renew with it.
    expect(await auth.getAccessToken()).toBe("fake-access-2");
    expect(calls).toEqual(["fake-refresh-1"]);

    diskAccepts();
    expect(await auth.getAccessToken()).toBe("fake-access-2");
    const saved = JSON.parse(readFileSync(credentialsPath, "utf-8"));
    expect(saved.claudeAiOauth.refreshToken).toBe("fake-refresh-2");
    expect(saved.claudeAiOauth.accessToken).toBe("fake-access-2");
  });

  test("the next renewal uses the rotated refresh token, not the dead one on disk", async () => {
    writeExpired("fake-access-1", "fake-refresh-1");
    // expires_in inside the 5-minute margin: the very next call renews again.
    const calls = rotatingEndpoint({
      "fake-refresh-1": { access: "fake-access-2", refresh: "fake-refresh-2", expiresIn: 60 },
      "fake-refresh-2": { access: "fake-access-3", refresh: "fake-refresh-3" },
    });
    diskRefuses();

    expect(await auth.getAccessToken()).toBe("fake-access-2");
    expect(await auth.getAccessToken()).toBe("fake-access-3");
    expect(calls).toEqual(["fake-refresh-1", "fake-refresh-2"]);
  });

  test("the failure is surfaced, without the token in the log", async () => {
    writeExpired("fake-access-1", "fake-refresh-1");
    rotatingEndpoint({ "fake-refresh-1": { access: "fake-access-2", refresh: "fake-refresh-2" } });
    diskRefuses();

    await auth.getAccessToken();
    expect(auth.unsavedCredentialsError()).toContain("OAUTH_CREDENTIALS_NOT_SAVED");
    expect(logged.join("\n")).toContain("OAUTH_CREDENTIALS_NOT_SAVED");
    expect(logged.join("\n")).not.toContain("fake-refresh-2");
    expect(logged.join("\n")).not.toContain("fake-access-2");

    diskAccepts();
    await auth.getAccessToken();
    expect(auth.unsavedCredentialsError()).toBeNull();
  });

  test("a new /login written to the same file wins over the pair in memory", async () => {
    writeExpired("fake-access-1", "fake-refresh-1");
    rotatingEndpoint({ "fake-refresh-1": { access: "fake-access-2", refresh: "fake-refresh-2" } });
    diskRefuses();
    expect(await auth.getAccessToken()).toBe("fake-access-2");

    diskAccepts();
    writeFileSync(credentialsPath, JSON.stringify({
      claudeAiOauth: { accessToken: "fake-login-access", refreshToken: "fake-login-refresh", expiresAt: Date.now() + 3_600_000 },
    }));
    expect(await auth.getAccessToken()).toBe("fake-login-access");
    const saved = JSON.parse(readFileSync(credentialsPath, "utf-8"));
    expect(saved.claudeAiOauth.refreshToken).toBe("fake-login-refresh");
  });
});
