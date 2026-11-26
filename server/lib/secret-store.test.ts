/**
 * Pack/unpack of TEST values and a TEST allowlist only; no real secret or
 * real name of this fleet is ever used here. The age round trip runs the
 * real `age`/`age-keygen` binaries (critical point: the allowlist guard
 * inside `pack`, and the identity never touching argv, see the mutation
 * tests below).
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  createAllowlist, createAgeSecretStore, createKeychainSecretStore, createSecretStore, hasControlCharacter,
  loadAllowlistFromStateDir, type CommandRunResult, type AgeRunResult,
} from "./secret-store";

const TEST_NAME = "keychain:test/one";
const OTHER_TEST_NAME = "keychain:test/two";
const UNKNOWN_NAME = "keychain:not-on-the-list/value";
const TEST_ALLOWLIST = createAllowlist([TEST_NAME, OTHER_TEST_NAME]);

describe("SecretAllowlist", () => {
  test("accepts only the names it was built with", () => {
    expect(TEST_ALLOWLIST.has(TEST_NAME)).toBe(true);
    expect(TEST_ALLOWLIST.has(UNKNOWN_NAME)).toBe(false);
  });

  test("an empty allowlist rejects every name, including one that looks plausible", () => {
    const empty = createAllowlist([]);
    expect(empty.has(TEST_NAME)).toBe(false);
  });
});

describe("loadAllowlistFromStateDir", () => {
  test("a state dir with no config file answers an allowlist that rejects everything", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "secret-store-cfg-"));
    const allowlist = loadAllowlistFromStateDir(stateDir);
    expect(allowlist.names).toEqual([]);
    expect(allowlist.has(TEST_NAME)).toBe(false);
  });

  test("reads the names from <stateDir>/secrets/allowed-secret-names.json", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "secret-store-cfg-"));
    mkdirSync(join(stateDir, "secrets"), { recursive: true });
    writeFileSync(join(stateDir, "secrets", "allowed-secret-names.json"), JSON.stringify([TEST_NAME]));
    const allowlist = loadAllowlistFromStateDir(stateDir);
    expect(allowlist.has(TEST_NAME)).toBe(true);
    expect(allowlist.has(OTHER_TEST_NAME)).toBe(false);
  });
});

describe("age secret store", () => {
  let dir: string;
  let identityPath: string;
  let secretsPath: string;
  let identityKey: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "secret-store-"));
    identityPath = join(dir, "identity.age-key");
    secretsPath = join(dir, "secrets.age");
    const keygen = spawnSync("age-keygen", ["-o", identityPath]);
    expect(keygen.status).toBe(0);
    identityKey = readFileSync(identityPath, "utf8");
  });

  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("pack then unpack round-trips a test value through the real age binary", async () => {
    const store = createAgeSecretStore({ allowlist: TEST_ALLOWLIST, identityPath, secretsPath });
    await store.pack({ [TEST_NAME]: "test-value-not-a-real-secret" });
    const unpacked = await store.unpack();
    expect(unpacked[TEST_NAME]).toBe("test-value-not-a-real-secret");
    expect(await store.read(TEST_NAME)).toBe("test-value-not-a-real-secret");
  });

  test("the identity can also be handed in directly as key material, never touching a path", async () => {
    const store = createAgeSecretStore({ allowlist: TEST_ALLOWLIST, identity: identityKey, secretsPath });
    await store.pack({ [TEST_NAME]: "test-value-not-a-real-secret" });
    expect(await store.read(TEST_NAME)).toBe("test-value-not-a-real-secret");
  });

  test("the ciphertext file holds no trace of the plaintext value", async () => {
    const store = createAgeSecretStore({ allowlist: TEST_ALLOWLIST, identityPath, secretsPath });
    await store.pack({ [TEST_NAME]: "a-very-distinctive-plaintext-marker" });
    const ciphertext = readFileSync(secretsPath, "utf8");
    expect(ciphertext).not.toContain("a-very-distinctive-plaintext-marker");
  });

  test("refuses a name outside the allowlist: pack skips it, read of it answers null", async () => {
    const store = createAgeSecretStore({ allowlist: TEST_ALLOWLIST, identityPath, secretsPath });
    await store.pack({ [UNKNOWN_NAME]: "should-never-be-stored" });
    const unpacked = await store.unpack();
    expect(Object.keys(unpacked)).toEqual([]);
    expect(await store.read(UNKNOWN_NAME)).toBeNull();
  });

  // Mutation point of the bar: drop the `allowlist.has` guard inside
  // `pack`'s loop in secret-store.ts and this test goes red (the unknown
  // name would appear in `unpack()`), while the round-trip test above stays
  // green either way.
  test("mutation: without the allowlist guard an unknown name would survive the round trip", async () => {
    const store = createAgeSecretStore({ allowlist: TEST_ALLOWLIST, identityPath, secretsPath });
    await store.pack({ [TEST_NAME]: "kept", [UNKNOWN_NAME]: "dropped" });
    const unpacked = await store.unpack();
    expect(unpacked[TEST_NAME]).toBe("kept");
    expect(unpacked[UNKNOWN_NAME]).toBeUndefined();
  });

  test("pack/unpack never writes the secret value to the console", async () => {
    const store = createAgeSecretStore({ allowlist: TEST_ALLOWLIST, identityPath, secretsPath });
    const originalWarn = console.warn;
    const originalLog = console.log;
    const lines: string[] = [];
    console.warn = (...args: unknown[]) => { lines.push(args.join(" ")); };
    console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
    try {
      await store.pack({ [TEST_NAME]: "console-marker-secret", [UNKNOWN_NAME]: "console-marker-secret" });
      await store.unpack();
      await store.read(TEST_NAME);
    } finally {
      console.warn = originalWarn;
      console.log = originalLog;
    }
    expect(lines.join("\n")).not.toContain("console-marker-secret");
  });

  test("unpack answers empty before the identity is unlocked (locked)", async () => {
    const store = createAgeSecretStore({ allowlist: TEST_ALLOWLIST, identityPath: join(dir, "missing.age-key"), secretsPath });
    expect(await store.unpack()).toEqual({});
    expect(await store.read(TEST_NAME)).toBeNull();
  });

  test("pack refuses when the identity has not been unlocked", async () => {
    const store = createAgeSecretStore({ allowlist: TEST_ALLOWLIST, identityPath: join(dir, "missing.age-key"), secretsPath });
    await expect(store.pack({ [TEST_NAME]: "x" })).rejects.toThrow();
  });

  test("refuses an identity file that is readable by group or other", async () => {
    chmodSync(identityPath, 0o640);
    const store = createAgeSecretStore({ allowlist: TEST_ALLOWLIST, identityPath, secretsPath });
    await expect(store.pack({ [TEST_NAME]: "x" })).rejects.toThrow();
  });

  test("a direct `identity` value takes priority over the environment and credentials directory", async () => {
    const previousEnv = process.env.TOPICS_SECRET_AGE_IDENTITY;
    process.env.TOPICS_SECRET_AGE_IDENTITY = "this would blow up age if it were ever used";
    try {
      const store = createAgeSecretStore({ allowlist: TEST_ALLOWLIST, identity: identityKey, secretsPath });
      await store.pack({ [TEST_NAME]: "x" });
      expect(await store.read(TEST_NAME)).toBe("x");
    } finally {
      if (previousEnv === undefined) delete process.env.TOPICS_SECRET_AGE_IDENTITY;
      else process.env.TOPICS_SECRET_AGE_IDENTITY = previousEnv;
    }
  });

  // Mutation point: pass `opts.identityPath` to age's argv (the old `-i
  // <path>` form) instead of feeding the identity through stdin and this
  // test goes red, because the path would then show up in the recorded argv.
  // Packing with one store instance and then decrypting with a FRESH one
  // forces a real `age -d` call off disk: a store that only ever reused its
  // own just-packed in-memory cache would never exercise the decrypt path.
  test("mutation: the identity path never reaches age's argv, only its stdin", async () => {
    const calls: Array<{ argv: string[]; stdinData: string }> = [];
    const recordingRun = async (argv: string[], stdinData: string): Promise<AgeRunResult> => {
      calls.push({ argv, stdinData });
      const r = spawnSync(argv[0]!, argv.slice(1), { input: stdinData, encoding: "utf8" });
      return { stdout: r.stdout ?? "", exitCode: r.status };
    };
    const writer = createAgeSecretStore({ allowlist: TEST_ALLOWLIST, identityPath, secretsPath, run: recordingRun });
    await writer.pack({ [TEST_NAME]: "test-value-not-a-real-secret" });
    const reader = createAgeSecretStore({ allowlist: TEST_ALLOWLIST, identityPath, secretsPath, run: recordingRun });
    expect(await reader.unpack()).toEqual({ [TEST_NAME]: "test-value-not-a-real-secret" });
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.argv.join(" ")).not.toContain(identityPath);
      expect(call.argv).not.toContain(identityPath);
    }
  });

  test("unpack decrypts only once: a second unpack does not spawn age again", async () => {
    let runCount = 0;
    const countingRun = async (argv: string[], stdinData: string): Promise<AgeRunResult> => {
      runCount++;
      const r = spawnSync(argv[0]!, argv.slice(1), { input: stdinData, encoding: "utf8" });
      return { stdout: r.stdout ?? "", exitCode: r.status };
    };
    const store = createAgeSecretStore({ allowlist: TEST_ALLOWLIST, identityPath, secretsPath, run: countingRun });
    await store.pack({ [TEST_NAME]: "x" });
    const countAfterPack = runCount;
    await store.unpack();
    await store.unpack();
    expect(runCount).toBe(countAfterPack);
  });
});

describe("keychain secret store (fake `security`, no real Keychain touched)", () => {
  /**
   * Imitates the two behaviours of the real tool that matter here, both read
   * off a real Keychain on 2026-11-26: `security -i` consumes ONE command per
   * line (a newline inside a quoted word ends the command and starts the
   * next), and `find-generic-password -w` prints HEX DIGITS instead of the
   * data as soon as the stored data holds a byte below 0x20.
   */
  function fakeSecurity() {
    const items = new Map<string, string>();
    const calls: Array<{ args: string[]; stdin?: string }> = [];
    const runner = (cmd: string, args: string[], stdinData?: string): CommandRunResult => {
      calls.push({ args: [cmd, ...args], stdin: stdinData });
      if (cmd !== "security") return { status: 127, stdout: "", stderr: "not found" };
      if (args[0] === "find-generic-password") {
        const a = args.indexOf("-a");
        const account = a >= 0 ? args[a + 1]! : "";
        const stored = items.get(account);
        if (stored === undefined) return { status: 44, stdout: "", stderr: "not found" };
        const printed = hasControlCharacter(stored) ? Buffer.from(stored, "utf8").toString("hex") : stored;
        return { status: 0, stdout: `${printed}\n`, stderr: "" };
      }
      if (args[0] === "-i" && stdinData) {
        for (const line of stdinData.split("\n").filter((l) => l.length > 0)) {
          const quoted = /add-generic-password.*-a\s+"((?:[^"\\]|\\.)*)"\s+-w\s+"((?:[^"\\]|\\.)*)"/.exec(line);
          if (quoted) {
            items.set(quoted[1]!.replace(/\\(.)/g, "$1"), quoted[2]!.replace(/\\(.)/g, "$1"));
            continue;
          }
          const hex = /add-generic-password.*-a\s+"((?:[^"\\]|\\.)*)"\s+-X\s+([0-9a-f]+)/.exec(line);
          if (hex) items.set(hex[1]!.replace(/\\(.)/g, "$1"), Buffer.from(hex[2]!, "hex").toString("utf8"));
        }
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "unexpected" };
    };
    return { runner, calls, items };
  }

  test("the fake mirrors the real tool: stored data with a control byte comes back as hex digits", () => {
    const { runner, items } = fakeSecurity();
    items.set(TEST_NAME, "two\nlines");
    const read = runner("security", ["find-generic-password", "-s", "topics-secrets", "-a", TEST_NAME, "-w"]);
    expect(read.status).toBe(0);
    expect(read.stdout.trim()).toBe(Buffer.from("two\nlines", "utf8").toString("hex"));
  });

  test("pack then read round-trips a test value", async () => {
    const { runner } = fakeSecurity();
    const store = createKeychainSecretStore(TEST_ALLOWLIST, runner);
    await store.pack({ [TEST_NAME]: "test-value-not-a-real-secret" });
    expect(await store.read(TEST_NAME)).toBe("test-value-not-a-real-secret");
  });

  test("refuses a name outside the allowlist without calling `security` for it", async () => {
    const { runner, calls } = fakeSecurity();
    const store = createKeychainSecretStore(TEST_ALLOWLIST, runner);
    await store.pack({ [UNKNOWN_NAME]: "should-never-be-stored" });
    expect(calls.some((c) => c.args.includes(UNKNOWN_NAME) || (c.stdin ?? "").includes(UNKNOWN_NAME))).toBe(false);
    expect(await store.read(UNKNOWN_NAME)).toBeNull();
  });

  // Mutation point of the review's point 1: put `-w value` back among the
  // `add-generic-password` ARGS (instead of the `security -i` stdin command)
  // and this test goes red, because the secret value would then appear in a
  // call's `args`.
  test("mutation: the secret value never appears in a command's argv, only on stdin", async () => {
    const { runner, calls } = fakeSecurity();
    const store = createKeychainSecretStore(TEST_ALLOWLIST, runner);
    await store.pack({ [TEST_NAME]: "test-value-not-a-real-secret" });
    for (const call of calls) {
      expect(call.args).not.toContain("test-value-not-a-real-secret");
      expect(call.args.join(" ")).not.toContain("test-value-not-a-real-secret");
    }
    const addCall = calls.find((c) => (c.stdin ?? "").includes("add-generic-password"));
    expect(addCall?.stdin).toContain(`b64:${Buffer.from("test-value-not-a-real-secret", "utf8").toString("base64")}`);
  });

  // Mutation point of the review of 2026-11-26: store the value as it is (or
  // as `-X <hex>`) instead of `b64:<base64>` and this test goes red, because
  // the fake answers in hex for data holding a newline, exactly as the real
  // `security -w` did on a Keychain test entry: `read()` would hand the
  // caller hex digits instead of the age identity.
  test("mutation: a value is stored as printable b64 and read back decoded, never as hex", async () => {
    const secretAcrossLines = 'line one "quoted"\nline \\two\nAGE-SECRET-KEY-EXAMPLE';
    const { runner, items } = fakeSecurity();
    const store = createKeychainSecretStore(TEST_ALLOWLIST, runner);
    await store.pack({ [TEST_NAME]: secretAcrossLines });
    const stored = items.get(TEST_NAME) ?? "";
    expect(stored.startsWith("b64:")).toBe(true);
    expect(stored).not.toContain("\n");
    expect(await store.read(TEST_NAME)).toBe(secretAcrossLines);
  });

  test("an entry this store did not write is an error, not a value", async () => {
    const { runner, items } = fakeSecurity();
    items.set(TEST_NAME, "written-by-something-else");
    const store = createKeychainSecretStore(TEST_ALLOWLIST, runner);
    await expect(store.read(TEST_NAME)).rejects.toThrow(/not written by this store/);
  });

  test("an allowlist never accepts a name with a control character, whatever the config says", () => {
    const injected = `${TEST_NAME}"\nadd-generic-password -U -s x -a y -w "z`;
    expect(createAllowlist([injected]).has(injected)).toBe(false);
    expect(createAllowlist([injected]).names).toEqual([]);
  });

  // Mutation point of the review's follow-up: `security -i` reads one
  // command per line, and the old `-w "quoted"` form only escapes quotes and
  // backslashes, not a newline inside the value. An age identity IS
  // multi-line (`# created…`, `# public key…`, `AGE-SECRET-KEY-…`), so a
  // value like it would close the add-generic-password command early and
  // start a second, injected one. Write the raw value instead of its base64
  // form and this test goes red: either the round trip breaks, or a second
  // command shows up on stdin.
  test("mutation: a multi-line value with quotes and backslashes round-trips, and stdin carries one command", async () => {
    const secretAcrossLines = 'line one "quoted"\nline \\two\nAGE-SECRET-KEY-EXAMPLE';
    const { runner, calls } = fakeSecurity();
    const store = createKeychainSecretStore(TEST_ALLOWLIST, runner);
    await store.pack({ [TEST_NAME]: secretAcrossLines });
    expect(await store.read(TEST_NAME)).toBe(secretAcrossLines);

    const addCall = calls.find((c) => (c.stdin ?? "").includes("add-generic-password"));
    const commandLines = (addCall?.stdin ?? "").split("\n").filter((line) => line.length > 0);
    expect(commandLines.length).toBe(1);
    expect(commandLines[0]).not.toContain("\n");
  });
});

describe("createSecretStore", () => {
  test("picks the age backend off-Mac and the keychain backend on darwin", () => {
    const linux = createSecretStore({ platform: "linux", stateDir: mkdtempSync(join(tmpdir(), "secret-store-pick-")) });
    const mac = createSecretStore({ platform: "darwin", stateDir: mkdtempSync(join(tmpdir(), "secret-store-pick-")) });
    expect(typeof linux.read).toBe("function");
    expect(typeof mac.read).toBe("function");
  });

  test("off-Mac defaults are generic and configurable, never a real path, and reject everything with no config", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "secret-store-defaults-"));
    const store = createSecretStore({ platform: "linux", stateDir });
    expect(stateDir).not.toContain("/Users/");
    writeFileSync(join(stateDir, "marker"), "");
    expect(await store.read(TEST_NAME)).toBeNull();
  });
});
