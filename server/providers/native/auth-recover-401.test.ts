/**
 * A 401 on a token that looks fresh is somebody else's renewal, not ours.
 *
 * `getAccessToken` renews on the clock. The CLI renews on its own clock and
 * writes the new pair to the SAME file, at which point the token the server
 * holds is revoked upstream while still "fresh" by its expiry. Measured on
 * 2026-09-03 (topic:9cb7c969): a 401 300ms after Enter with a good token on
 * disk. The recovery must read the disk before touching the network.
 * @covers CHAT-REL-06
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { recoverAfter401 } from "./auth";

const HOME_VERA = process.env.HOME;
const realFetch = globalThis.fetch;
let homeDir: string;
let credentialsPath: string;

function writeCredentialsFile(accessToken: string, refreshToken = "r") {
  writeFileSync(credentialsPath, JSON.stringify({
    claudeAiOauth: { accessToken, refreshToken, expiresAt: Date.now() + 3_600_000 },
  }));
}

describe("recoverAfter401", () => {
  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "auth-401-"));
    mkdirSync(join(homeDir, ".claude"), { recursive: true });
    credentialsPath = join(homeDir, ".claude", ".credentials.json");
    process.env.HOME = homeDir;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (HOME_VERA === undefined) delete process.env.HOME; else process.env.HOME = HOME_VERA;
    try { rmSync(homeDir, { recursive: true, force: true }); } catch { /* scratch */ }
  });

  test("the file already carries a different token: take it, no network call", async () => {
    writeCredentialsFile("rotated-by-the-cli");
    let fetched = 0;
    globalThis.fetch = (async () => { fetched++; return new Response("{}", { status: 500 }); }) as unknown as typeof fetch;
    const got = await recoverAfter401("the-one-that-failed");
    expect(got).toBe("rotated-by-the-cli");
    expect(fetched).toBe(0);
  });

  test("the file still carries the failed token: renew through the token endpoint and save the new pair", async () => {
    writeCredentialsFile("stale", "refresh-1");
    let body = "";
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      body = String(init?.body ?? "");
      return new Response(JSON.stringify({ access_token: "renewed", refresh_token: "refresh-2", expires_in: 28800 }), { status: 200 });
    }) as unknown as typeof fetch;
    const got = await recoverAfter401("stale");
    expect(got).toBe("renewed");
    expect(body).toContain("refresh-1");
    const saved = JSON.parse(readFileSync(credentialsPath, "utf-8"));
    expect(saved.claudeAiOauth.accessToken).toBe("renewed");
    expect(saved.claudeAiOauth.refreshToken).toBe("refresh-2");
  });

  test("the renewal is refused (the refresh token is gone): null, so the caller says /login instead of looping", async () => {
    writeCredentialsFile("stale");
    globalThis.fetch = (async () => new Response('{"error":"invalid_grant"}', { status: 400 })) as unknown as typeof fetch;
    expect(await recoverAfter401("stale")).toBeNull();
  });

  test("no credentials at all: null", async () => {
    rmSync(credentialsPath, { force: true });
    expect(await recoverAfter401("whatever")).toBeNull();
  });
});
