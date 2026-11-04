/**
 * Il token di `claude setup-token` dura un anno e non ha refresh token.
 * Il 04/11 il parser lo scartava, si ripiegava su `~/.jcode/auth.json` vecchio
 * e ogni turno di Jarvis moriva su `invalid_grant`.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getAccessToken, readCredentials } from "./auth";

const HOME_VERA = process.env.HOME;
let homeDir: string;

function write(rel: string, doc: unknown) {
  writeFileSync(join(homeDir, rel), JSON.stringify(doc));
}

describe("un login senza refresh token (setup-token)", () => {
  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "auth-setup-token-"));
    mkdirSync(join(homeDir, ".claude"), { recursive: true });
    mkdirSync(join(homeDir, ".jcode"), { recursive: true });
    process.env.HOME = homeDir;
  });
  afterEach(() => {
    if (HOME_VERA === undefined) delete process.env.HOME; else process.env.HOME = HOME_VERA;
    rmSync(homeDir, { recursive: true, force: true });
  });

  test("vince su un login vecchio rinnovabile", () => {
    write(".claude/.credentials.json", { claudeAiOauth: { accessToken: "setup", refreshToken: null, expiresAt: Date.now() + 300 * 86_400_000 } });
    write(".jcode/auth.json", { anthropic_accounts: [{ access: "vecchio", refresh: "morto", expires: Date.now() - 86_400_000 }] });
    expect(readCredentials()?.accessToken).toBe("setup");
  });

  test("oltre la scadenza scritta non prova a rinnovare: usa il token", async () => {
    write(".claude/.credentials.json", { claudeAiOauth: { accessToken: "setup", refreshToken: null, expiresAt: Date.now() - 60_000 } });
    const realFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => { called = true; throw new Error("niente rete"); }) as typeof fetch;
    try {
      expect(await getAccessToken()).toBe("setup");
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
