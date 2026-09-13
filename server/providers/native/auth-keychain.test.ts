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
/** Items under other accounts, same service; the service-only lookup meets them FIRST. */
let shadows: Array<{ acct: string; doc: Record<string, unknown> }>;
const ITEM_ACCOUNT = "someone";
const ORIGINAL_USER = process.env.USER;

function fakeSecurity(cmd: string, args: string[]): KeychainRunResult {
  calls.push([cmd, ...args]);
  if (cmd !== "security") return { status: 127, stdout: "", stderr: "not found" };
  const a = args.indexOf("-a");
  const account = a >= 0 ? args[a + 1]! : null;
  if (args[0] === "find-generic-password") {
    const all = [...shadows, ...(item ? [{ acct: ITEM_ACCOUNT, doc: item }] : [])];
    const hit = account === null ? all[0] : all.find((i) => i.acct === account);
    if (!hit) return { status: 44, stdout: "", stderr: "The specified item could not be found in the keychain." };
    if (args.includes("-w")) return { status: 0, stdout: JSON.stringify(hit.doc) + "\n", stderr: "" };
    return { status: 0, stdout: `keychain: "/Users/x/Library/Keychains/login.keychain-db"\n    "acct"<blob>="${hit.acct}"\n    "svce"<blob>="Claude Code-credentials"\n`, stderr: "" };
  }
  if (args[0] === "add-generic-password") {
    const w = args.indexOf("-w");
    const doc = JSON.parse(args[w + 1]!);
    const shadow = shadows.find((i) => i.acct === account);
    if (shadow) shadow.doc = doc; else item = doc;
    return { status: 0, stdout: "", stderr: "" };
  }
  return { status: 1, stdout: "", stderr: "unexpected" };
}

function writeFileCredentials(accessToken: string, expiresAt: number) {
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
    shadows = [];
    process.env.USER = ITEM_ACCOUNT;
    item = { claudeAiOauth: { accessToken: "kc-live", refreshToken: "kc-refresh", expiresAt: Date.now() + 5 * 3_600_000, scopes: ["user:inference"], subscriptionType: "max" }, mcpOAuth: { keep: "me" } };
    setKeychainRunnerForTests(fakeSecurity);
    process.env.TOPICS_CREDENTIALS_KEYCHAIN = "1";
  });

  afterEach(() => {
    setKeychainRunnerForTests(null);
    if (ORIGINAL_USER === undefined) delete process.env.USER; else process.env.USER = ORIGINAL_USER;
    if (HOME_VERA === undefined) delete process.env.HOME; else process.env.HOME = HOME_VERA;
    if (FLAG_VERA === undefined) delete process.env.TOPICS_CREDENTIALS_KEYCHAIN; else process.env.TOPICS_CREDENTIALS_KEYCHAIN = FLAG_VERA;
    try { rmSync(homeDir, { recursive: true, force: true }); } catch { /* scratch */ }
  });

  test("off under bun test (NODE_ENV=test) and when set to 0: `security` is never called and the file wins", () => {
    delete process.env.TOPICS_CREDENTIALS_KEYCHAIN;
    expect(process.env.NODE_ENV).toBe("test");
    writeFileCredentials("file-live", Date.now() + 3_600_000);
    expect(readCredentials()?.accessToken).toBe("file-live");
    expect(calls.length).toBe(0);
    process.env.TOPICS_CREDENTIALS_KEYCHAIN = "0";
    writeFileCredentials("file-live", Date.now() + 3_600_000);
    expect(readCredentials()?.accessToken).toBe("file-live");
    expect(calls.length).toBe(0);
  });

  // The Keychain candidate exists on macOS only (`keychainEnabled()` says no
  // on any other platform before it looks at the flag), so the two cases that
  // switch it ON have nothing to drive on the Linux CI runner: there the file
  // wins, and asserting "kc-live" would only be asserting the platform.
  const onMac = test.skipIf(process.platform !== "darwin");

  onMac("on: the Keychain is the first candidate and beats a stale file (the 2026-09-03 shape)", () => {
    writeFileCredentials("file-revoked", Date.now() - 63 * 24 * 3_600_000);
    const c = readCredentials() as { accessToken: string; sourcePath?: string };
    expect(c.accessToken).toBe("kc-live");
    expect(c.sourcePath).toBe(KEYCHAIN_SOURCE);
  });

  onMac("a 401 on the file's token: the recovery finds the Keychain's fresher one without touching the network", async () => {
    writeFileCredentials("file-stale", Date.now() + 3_600_000);
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
    expect(add[add.indexOf("-a") + 1]).toBe("someone");
    const doc = item as { claudeAiOauth: Record<string, unknown>; mcpOAuth: unknown };
    expect(doc.claudeAiOauth.accessToken).toBe("renewed");
    expect(doc.claudeAiOauth.refreshToken).toBe("renewed-refresh");
    expect(doc.claudeAiOauth.subscriptionType).toBe("max");
    expect(doc.mcpOAuth).toEqual({ keep: "me" });
  });

  test("no item in the Keychain: the candidate is simply absent, the files decide", () => {
    item = null;
    writeFileCredentials("file-live", Date.now() + 3_600_000);
    expect(readCredentials()?.accessToken).toBe("file-live");
    expect(readKeychainCredentials()).toBeNull();
  });

  // The 2026-09-13 shape: a blank item under account "unknown" met first by the
  // service-only lookup, the live pair under the login user. Called directly,
  // so it runs on the Linux CI runner too.
  describe("a blank item under another account", () => {
    const blank = () => ({ acct: "unknown", doc: { claudeAiOauth: { accessToken: "", refreshToken: "", expiresAt: 0, subscriptionType: "max" } } });

    test("does not shadow the login user's live pair on read", () => {
      shadows = [blank()];
      expect(readKeychainCredentials()?.accessToken).toBe("kc-live");
      const firstLookup = calls.find((c) => c[1] === "find-generic-password")!;
      expect(firstLookup[firstLookup.indexOf("-a") + 1]).toBe(ITEM_ACCOUNT);
    });

    test("a renewal updates the login user's item and leaves the blank one alone", () => {
      shadows = [blank()];
      writeCredentials(KEYCHAIN_SOURCE, { accessToken: "renewed", refreshToken: "renewed-refresh", expiresAt: 123 });
      const add = calls.find((c) => c[1] === "add-generic-password")!;
      expect(add[add.indexOf("-a") + 1]).toBe(ITEM_ACCOUNT);
      expect((item as { claudeAiOauth: Record<string, unknown> }).claudeAiOauth.accessToken).toBe("renewed");
      expect((shadows[0]!.doc.claudeAiOauth as Record<string, unknown>).accessToken).toBe("");
    });

    test("with no login-user item, the service-only lookup still finds a usable one", () => {
      const live = item!;
      item = null;
      shadows = [{ acct: "cli-wrote-this", doc: live }];
      expect(readKeychainCredentials()?.accessToken).toBe("kc-live");
    });
  });
});
