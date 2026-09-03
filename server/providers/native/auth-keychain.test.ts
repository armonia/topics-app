/**
 * The macOS Keychain is where Claude Code keeps the token; the server must
 * read it there, and write a renewal back there.
 *
 * On 2026-09-03 `~/.claude/.credentials.json` held a token revoked 63 days
 * earlier while the Keychain held the live one; the 401 of that morning was
 * the lag between the CLI rotating the pair and the file mirror catching up.
 * Driven with a fake `security` binary: no real Keychain is read or written,
 * and the flag stays off unless the test turns it on.
 * @covers CHAT-REL-06
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  KEYCHAIN_SOURCE, readCredentials, readKeychainCredentials, recoverAfter401, setKeychainRunnerForTests,
  writeCredentials, type KeychainRunResult,
} from "./auth";

const HOME_VERA = process.env.HOME;
const FLAG_VERA = process.env.TOPICS_CREDENTIALS_KEYCHAIN;
let homeDir: string;
let calls: string[][];
let item: Record<string, unknown> | null;

function fakeSecurity(cmd: string, args: string[]): KeychainRunResult {
  calls.push([cmd, ...args]);
  if (cmd !== "security") return { status: 127, stdout: "", stderr: "not found" };
  if (args[0] === "find-generic-password") {
    if (!item) return { status: 44, stdout: "", stderr: "The specified item could not be found in the keychain." };
    if (args.includes("-w")) return { status: 0, stdout: JSON.stringify(item) + "\n", stderr: "" };
    return { status: 0, stdout: 'keychain: "/Users/x/Library/Keychains/login.keychain-db"\n    "acct"<blob>="zorahrel"\n    "svce"<blob>="Claude Code-credentials"\n', stderr: "" };
  }
  if (args[0] === "add-generic-password") {
    const w = args.indexOf("-w");
    item = JSON.parse(args[w + 1]!);
    return { status: 0, stdout: "", stderr: "" };
  }
  return { status: 1, stdout: "", stderr: "unexpected" };
}

function fileCreds(accessToken: string, expiresAt: number) {
  writeFileSync(join(homeDir, ".claude", ".credentials.json"), JSON.stringify({
    claudeAiOauth: { accessToken, refreshToken: "file-refresh", expiresAt },
  }));
}

describe("the Keychain candidate", () => {
  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "auth-keychain-"));
    mkdirSync(join(homeDir, ".claude"), { recursive: true });
    process.env.HOME = homeDir;
    calls = [];
    item = { claudeAiOauth: { accessToken: "kc-live", refreshToken: "kc-refresh", expiresAt: Date.now() + 5 * 3_600_000, scopes: ["user:inference"], subscriptionType: "max" }, mcpOAuth: { keep: "me" } };
    setKeychainRunnerForTests(fakeSecurity);
    process.env.TOPICS_CREDENTIALS_KEYCHAIN = "1";
  });

  afterEach(() => {
    setKeychainRunnerForTests(null);
    if (HOME_VERA === undefined) delete process.env.HOME; else process.env.HOME = HOME_VERA;
    if (FLAG_VERA === undefined) delete process.env.TOPICS_CREDENTIALS_KEYCHAIN; else process.env.TOPICS_CREDENTIALS_KEYCHAIN = FLAG_VERA;
    try { rmSync(homeDir, { recursive: true, force: true }); } catch { /* scratch */ }
  });

  test("off under bun test (NODE_ENV=test) and when set to 0: `security` is never called and the file wins", () => {
    delete process.env.TOPICS_CREDENTIALS_KEYCHAIN;
    expect(process.env.NODE_ENV).toBe("test");
    fileCreds("file-live", Date.now() + 3_600_000);
    expect(readCredentials()?.accessToken).toBe("file-live");
    expect(calls.length).toBe(0);
    process.env.TOPICS_CREDENTIALS_KEYCHAIN = "0";
    fileCreds("file-live", Date.now() + 3_600_000);
    expect(readCredentials()?.accessToken).toBe("file-live");
    expect(calls.length).toBe(0);
  });

  test("on: the Keychain is the first candidate and beats a stale file (the 2026-09-03 shape)", () => {
    fileCreds("file-revoked", Date.now() - 63 * 24 * 3_600_000);
    const c = readCredentials() as { accessToken: string; sourcePath?: string };
    expect(c.accessToken).toBe("kc-live");
    expect(c.sourcePath).toBe(KEYCHAIN_SOURCE);
  });

  test("a 401 on the file's token: the recovery finds the Keychain's fresher one without touching the network", async () => {
    fileCreds("file-stale", Date.now() + 3_600_000);
    const realFetch = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = (async () => { fetched++; return new Response("{}", { status: 500 }); }) as unknown as typeof fetch;
    try {
      expect(await recoverAfter401("file-stale")).toBe("kc-live");
      expect(fetched).toBe(0);
    } finally { globalThis.fetch = realFetch; }
  });

  test("a renewal from the Keychain is written back to the Keychain, preserving the CLI's sibling keys", () => {
    writeCredentials(KEYCHAIN_SOURCE, { accessToken: "renewed", refreshToken: "renewed-refresh", expiresAt: 123 });
    const add = calls.find((c) => c[1] === "add-generic-password")!;
    expect(add).toBeDefined();
    expect(add).toContain("-U");
    expect(add[add.indexOf("-a") + 1]).toBe("zorahrel");
    const doc = item as { claudeAiOauth: Record<string, unknown>; mcpOAuth: unknown };
    expect(doc.claudeAiOauth.accessToken).toBe("renewed");
    expect(doc.claudeAiOauth.refreshToken).toBe("renewed-refresh");
    expect(doc.claudeAiOauth.subscriptionType).toBe("max");
    expect(doc.mcpOAuth).toEqual({ keep: "me" });
  });

  test("no item in the Keychain: the candidate is simply absent, the files decide", () => {
    item = null;
    fileCreds("file-live", Date.now() + 3_600_000);
    expect(readCredentials()?.accessToken).toBe("file-live");
    expect(readKeychainCredentials()).toBeNull();
  });
});
