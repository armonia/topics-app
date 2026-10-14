/**
 * A native turn reads its credentials without stopping the server's loop.
 *
 * The Keychain read (`security`, ~30ms) ran through `spawnSync` on every turn:
 * the one loop of the server, every other chat and every frame being streamed,
 * waited with it (T16). The turn's path now asks the asynchronous runner, and
 * still reads the Keychain on every turn: a switch of account made with the CLI
 * counts from the next turn, as before.
 *
 * The Keychain exists on macOS only, so `process.platform` is set to `darwin`
 * for these cases and `security` is a fake: no real Keychain is read or written.
 * @covers CHAT-REL-06
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as auth from "./auth";

const PLATFORM = Object.getOwnPropertyDescriptor(process, "platform")!;
const HOME_BEFORE = process.env.HOME;
const FLAG_BEFORE = process.env.TOPICS_CREDENTIALS_KEYCHAIN;
const USER_BEFORE = process.env.USER;
const realFetch = globalThis.fetch;
const realError = console.error;
const ACCOUNT = "someone";

let homeDir: string;
let item: Record<string, unknown> | null;
let locked: boolean;
let syncCalls: string[][];
let asyncCalls: string[][];
/** When set, the next asynchronous lookup waits for `release()` and answers with the Keychain as it is then. */
let holdNext: boolean;
let release: (() => void) | null;

function security(cmd: string, args: string[]): auth.KeychainRunResult {
  if (cmd !== "security") return { status: 127, stdout: "", stderr: "not found" };
  if (locked) return { status: 36, stdout: "", stderr: "User interaction is not allowed." };
  if (args[0] === "find-generic-password") {
    if (!item) return { status: 44, stdout: "", stderr: "The specified item could not be found in the keychain." };
    if (args.includes("-w")) return { status: 0, stdout: JSON.stringify(item) + "\n", stderr: "" };
    return { status: 0, stdout: `    "acct"<blob>="${ACCOUNT}"\n`, stderr: "" };
  }
  if (args[0] === "add-generic-password") {
    item = JSON.parse(args[args.indexOf("-w") + 1]!);
    return { status: 0, stdout: "", stderr: "" };
  }
  return { status: 1, stdout: "", stderr: "unexpected" };
}

function syncSecurity(cmd: string, args: string[]): auth.KeychainRunResult {
  syncCalls.push([cmd, ...args]);
  return security(cmd, args);
}

async function asyncSecurity(cmd: string, args: string[]): Promise<auth.KeychainRunResult> {
  asyncCalls.push([cmd, ...args]);
  if (holdNext) {
    holdNext = false;
    await new Promise<void>((resolve) => { release = resolve; });
  }
  await new Promise((r) => setTimeout(r, 1));
  return security(cmd, args);
}

function keychainHolds(accessToken: string, refreshToken: string, expiresInMs: number) {
  item = { claudeAiOauth: { accessToken, refreshToken, expiresAt: Date.now() + expiresInMs, subscriptionType: "max" }, mcpOAuth: { keep: "me" } };
}

describe("the native turn's credentials", () => {
  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "auth-turn-async-"));
    mkdirSync(join(homeDir, ".claude"), { recursive: true });
    process.env.HOME = homeDir;
    process.env.USER = ACCOUNT;
    process.env.TOPICS_CREDENTIALS_KEYCHAIN = "1";
    Object.defineProperty(process, "platform", { ...PLATFORM, value: "darwin" });
    item = null;
    locked = false;
    syncCalls = [];
    asyncCalls = [];
    holdNext = false;
    release = null;
    auth.setKeychainRunnerForTests(syncSecurity, asyncSecurity);
    console.error = () => {};
  });

  afterEach(async () => {
    // A pair a case left in memory is saved here, while its Keychain answers.
    locked = false;
    await auth.getAccessToken().catch(() => null);
    auth.setKeychainRunnerForTests(null);
    Object.defineProperty(process, "platform", PLATFORM);
    globalThis.fetch = realFetch;
    console.error = realError;
    if (HOME_BEFORE === undefined) delete process.env.HOME; else process.env.HOME = HOME_BEFORE;
    if (USER_BEFORE === undefined) delete process.env.USER; else process.env.USER = USER_BEFORE;
    if (FLAG_BEFORE === undefined) delete process.env.TOPICS_CREDENTIALS_KEYCHAIN;
    else process.env.TOPICS_CREDENTIALS_KEYCHAIN = FLAG_BEFORE;
    try { rmSync(homeDir, { recursive: true, force: true }); } catch { /* scratch */ }
  });

  test("an account switched in the Keychain between two turns: the second turn uses the new token", async () => {
    keychainHolds("kc-first-account", "kc-first-refresh", 3_600_000);
    expect(await auth.getAccessToken()).toBe("kc-first-account");
    keychainHolds("kc-second-account", "kc-second-refresh", 3_600_000);
    expect(await auth.getAccessToken()).toBe("kc-second-account");
  });

  test("the turn's path asks `security` asynchronously, never through spawnSync", async () => {
    keychainHolds("kc-live", "kc-refresh", 3_600_000);
    expect(await auth.getAccessToken()).toBe("kc-live");
    // A 401 on a token the CLI has since rotated: the recovery reads the Keychain again.
    keychainHolds("kc-rotated", "kc-refresh-rotated", 3_600_000);
    expect(await auth.recoverAfter401("kc-live")).toBe("kc-rotated");
    expect(asyncCalls.length).toBeGreaterThan(0);
    expect(syncCalls).toEqual([]);
  });

  test("`hasCredentials` (the `connected` getter) answers from a credential file without a process", () => {
    keychainHolds("kc-live", "kc-refresh", 3_600_000);
    writeFileSync(join(homeDir, ".claude", ".credentials.json"), JSON.stringify({
      claudeAiOauth: { accessToken: "file-live", refreshToken: "file-refresh", expiresAt: Date.now() + 3_600_000 },
    }));
    expect(auth.hasCredentials()).toBe(true);
    expect(syncCalls).toEqual([]);
  });

  test("`hasCredentials` with no credential file still finds the Keychain's, or says there is none", () => {
    keychainHolds("kc-live", "kc-refresh", 3_600_000);
    expect(auth.hasCredentials()).toBe(true);
    item = null;
    expect(auth.hasCredentials()).toBe(false);
  });

  // The read now waits on `security`, and a renewal can land in that wait. The
  // pending pair the read started from may be gone by then: acting on it wrote a
  // spent pair back to the Keychain and dropped the one just renewed.
  test("a renewal that lands while a turn waits on the Keychain is not undone by that turn", async () => {
    keychainHolds("kc-access-1", "kc-refresh-1", -1000);
    const chain: Record<string, { access: string; refresh: string; expiresIn: number }> = {
      // Inside the five-minute margin: the next turn renews again.
      "kc-refresh-1": { access: "kc-access-2", refresh: "kc-refresh-2", expiresIn: 60 },
      "kc-refresh-2": { access: "kc-access-3", refresh: "kc-refresh-3", expiresIn: 28_800 },
    };
    const spent = new Set<string>();
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body ?? "{}")).refresh_token as string;
      const next = chain[sent];
      if (!next || spent.has(sent)) return new Response('{"error":"invalid_grant"}', { status: 400 });
      spent.add(sent);
      locked = true; // the Keychain locks between the renewal and its write
      return new Response(JSON.stringify({ access_token: next.access, refresh_token: next.refresh, expires_in: next.expiresIn }), { status: 200 });
    }) as unknown as typeof fetch;

    // First renewal: the pair 2 stays in memory, the Keychain still holds 1.
    expect(await auth.getAccessToken()).toBe("kc-access-2");
    expect(auth.unsavedCredentialsError()).toContain("OAUTH_CREDENTIALS_NOT_SAVED");

    // Turn A starts from the pending pair 2 and waits on the Keychain.
    holdNext = true;
    const turnA = auth.getAccessToken();
    await new Promise((r) => setTimeout(r, 5));
    expect(release).not.toBeNull();

    // Turn B renews meanwhile (2 is inside the margin): pair 3, again unsaved.
    expect(await auth.getAccessToken()).toBe("kc-access-3");

    // The Keychain unlocks and A's read comes back.
    locked = false;
    release!();
    expect(await turnA).toBe("kc-access-3");
    const saved = (item as { claudeAiOauth: { refreshToken: string } }).claudeAiOauth.refreshToken;
    expect(saved, "turn A wrote back the spent pair 2 over the renewed 3").toBe("kc-refresh-3");
    expect(auth.unsavedCredentialsError()).toBeNull();
  });
});
