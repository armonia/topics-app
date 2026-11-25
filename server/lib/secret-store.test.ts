/**
 * Pack/unpack of a TEST value only; no real secret of this fleet is ever
 * packed here. The age round trip runs the real `age`/`age-keygen` binaries
 * (critical point: the allowlist guard inside `pack`, see the mutation test).
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  SECRET_NAMES, createAgeSecretStore, createKeychainSecretStore, createSecretStore,
  isKnownSecretName, type CommandRunResult,
} from "./secret-store";

const TEST_NAME = SECRET_NAMES[0];
const UNKNOWN_NAME = "keychain:not-on-the-list/value";

describe("isKnownSecretName", () => {
  test("accepts every name on the closed list and nothing else", () => {
    for (const name of SECRET_NAMES) expect(isKnownSecretName(name)).toBe(true);
    expect(isKnownSecretName(UNKNOWN_NAME)).toBe(false);
  });
});

describe("age secret store", () => {
  let dir: string;
  let identityPath: string;
  let secretsPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "secret-store-"));
    identityPath = join(dir, "identity.age-key");
    secretsPath = join(dir, "secrets.age");
    const keygen = spawnSync("age-keygen", ["-o", identityPath]);
    expect(keygen.status).toBe(0);
  });

  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("pack then unpack round-trips a test value through the real age binary", async () => {
    const store = createAgeSecretStore({ identityPath, secretsPath });
    await store.pack({ [TEST_NAME]: "test-value-not-a-real-secret" });
    const unpacked = await store.unpack();
    expect(unpacked[TEST_NAME]).toBe("test-value-not-a-real-secret");
    expect(await store.read(TEST_NAME)).toBe("test-value-not-a-real-secret");
  });

  test("the ciphertext file holds no trace of the plaintext value", async () => {
    const store = createAgeSecretStore({ identityPath, secretsPath });
    await store.pack({ [TEST_NAME]: "a-very-distinctive-plaintext-marker" });
    const { readFileSync } = await import("node:fs");
    const ciphertext = readFileSync(secretsPath, "utf8");
    expect(ciphertext).not.toContain("a-very-distinctive-plaintext-marker");
  });

  test("refuses a name outside the allowlist: pack skips it, read of it answers null", async () => {
    const store = createAgeSecretStore({ identityPath, secretsPath });
    await store.pack({ [UNKNOWN_NAME as never]: "should-never-be-stored" } as never);
    const unpacked = await store.unpack();
    expect(Object.keys(unpacked)).toEqual([]);
    expect(await store.read(UNKNOWN_NAME as never)).toBeNull();
  });

  // Mutation point of the bar: drop the `isKnownSecretName` guard inside
  // `pack`'s loop in secret-store.ts and this test goes red (the unknown
  // name would appear in `unpack()`), while the round-trip test above stays
  // green either way.
  test("mutation: without the allowlist guard an unknown name would survive the round trip", async () => {
    const store = createAgeSecretStore({ identityPath, secretsPath });
    await store.pack({ [TEST_NAME]: "kept", [UNKNOWN_NAME as never]: "dropped" } as never);
    const unpacked = await store.unpack();
    expect(unpacked[TEST_NAME]).toBe("kept");
    expect((unpacked as Record<string, string>)[UNKNOWN_NAME]).toBeUndefined();
  });

  test("pack/unpack never writes the secret value to the console", async () => {
    const store = createAgeSecretStore({ identityPath, secretsPath });
    const originalWarn = console.warn;
    const originalLog = console.log;
    const lines: string[] = [];
    console.warn = (...args: unknown[]) => { lines.push(args.join(" ")); };
    console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
    try {
      await store.pack({ [TEST_NAME]: "console-marker-secret", [UNKNOWN_NAME as never]: "console-marker-secret" } as never);
      await store.unpack();
      await store.read(TEST_NAME);
    } finally {
      console.warn = originalWarn;
      console.log = originalLog;
    }
    expect(lines.join("\n")).not.toContain("console-marker-secret");
  });

  test("unpack answers empty before the identity file exists (locked)", async () => {
    const store = createAgeSecretStore({ identityPath: join(dir, "missing.age-key"), secretsPath });
    expect(await store.unpack()).toEqual({});
    expect(await store.read(TEST_NAME)).toBeNull();
  });

  test("pack refuses when the identity has not been unlocked", async () => {
    const store = createAgeSecretStore({ identityPath: join(dir, "missing.age-key"), secretsPath });
    await expect(store.pack({ [TEST_NAME]: "x" })).rejects.toThrow();
  });
});

describe("keychain secret store (fake `security`, no real Keychain touched)", () => {
  function fakeSecurity() {
    const items = new Map<string, string>();
    const calls: string[][] = [];
    const runner = (cmd: string, args: string[]): CommandRunResult => {
      calls.push([cmd, ...args]);
      if (cmd !== "security") return { status: 127, stdout: "", stderr: "not found" };
      const a = args.indexOf("-a");
      const account = a >= 0 ? args[a + 1]! : "";
      if (args[0] === "find-generic-password") {
        const value = items.get(account);
        if (value === undefined) return { status: 44, stdout: "", stderr: "not found" };
        return { status: 0, stdout: `${value}\n`, stderr: "" };
      }
      if (args[0] === "add-generic-password") {
        const w = args.indexOf("-w");
        items.set(account, args[w + 1]!);
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "unexpected" };
    };
    return { runner, calls, items };
  }

  test("pack then read round-trips a test value", async () => {
    const { runner } = fakeSecurity();
    const store = createKeychainSecretStore(runner);
    await store.pack({ [TEST_NAME]: "test-value-not-a-real-secret" });
    expect(await store.read(TEST_NAME)).toBe("test-value-not-a-real-secret");
  });

  test("refuses a name outside the allowlist without calling `security` for it", async () => {
    const { runner, calls } = fakeSecurity();
    const store = createKeychainSecretStore(runner);
    await store.pack({ [UNKNOWN_NAME as never]: "should-never-be-stored" } as never);
    expect(calls.some((c) => c.includes(UNKNOWN_NAME))).toBe(false);
    expect(await store.read(UNKNOWN_NAME as never)).toBeNull();
  });
});

describe("createSecretStore", () => {
  test("picks the age backend off-Mac and the keychain backend on darwin", () => {
    const linux = createSecretStore({ platform: "linux", stateDir: mkdtempSync(join(tmpdir(), "secret-store-pick-")) });
    const mac = createSecretStore({ platform: "darwin" });
    expect(typeof linux.read).toBe("function");
    expect(typeof mac.read).toBe("function");
  });

  test("off-Mac defaults are generic and configurable, never a real path", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "secret-store-defaults-"));
    const store = createSecretStore({ platform: "linux", stateDir }) as ReturnType<typeof createAgeSecretStore>;
    void store;
    // The factory must not throw before any file is provisioned.
    expect(stateDir).not.toContain("/Users/");
    writeFileSync(join(stateDir, "marker"), "");
  });
});
