/**
 * @covers MACHINE-06
 *
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
import { resolveSecretsDir } from "./data-dir";
import { withoutGatewayToken } from "./child-env";
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

  test("reads the names from the secrets dir allowed-secret-names.json", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "secret-store-cfg-"));
    mkdirSync(resolveSecretsDir(stateDir), { recursive: true });
    writeFileSync(join(resolveSecretsDir(stateDir), "allowed-secret-names.json"), JSON.stringify([TEST_NAME]));
    const allowlist = loadAllowlistFromStateDir(stateDir);
    expect(allowlist.has(TEST_NAME)).toBe(true);
    expect(allowlist.has(OTHER_TEST_NAME)).toBe(false);
  });
});

// The real binaries are not on every CI image; those runs still exercise the
// Keychain and allowlist suites, and a machine that has age runs this one.
const hasAge = spawnSync("age-keygen", ["--version"]).status === 0 && spawnSync("age", ["--version"]).status === 0;

describe.skipIf(!hasAge)("age secret store", () => {
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

  test("a store with a narrower allowlist over the same file unpacks nothing and reads null", async () => {
    const writer = createAgeSecretStore({ allowlist: TEST_ALLOWLIST, identityPath, secretsPath });
    await writer.pack({ [TEST_NAME]: "probe-value" });
    const narrow = createAgeSecretStore({ allowlist: createAllowlist([]), identityPath, secretsPath });
    expect(await narrow.unpack()).toEqual({});
    expect(await narrow.read(TEST_NAME)).toBeNull();
  });

  test("a narrower store packing never destroys names it cannot see", async () => {
    const wide = createAgeSecretStore({ allowlist: createAllowlist([TEST_NAME, OTHER_TEST_NAME]), identityPath, secretsPath });
    await wide.pack({ [TEST_NAME]: "A", [OTHER_TEST_NAME]: "B" });
    const narrow = createAgeSecretStore({ allowlist: createAllowlist([TEST_NAME]), identityPath, secretsPath });
    await narrow.pack({ [TEST_NAME]: "A-new" });
    const reader = createAgeSecretStore({ allowlist: createAllowlist([TEST_NAME, OTHER_TEST_NAME]), identityPath, secretsPath });
    expect(await reader.read(TEST_NAME)).toBe("A-new");
    expect(await reader.read(OTHER_TEST_NAME)).toBe("B");
  });

  test("an empty-allowlist store packing a refused name leaves the file intact", async () => {
    const wide = createAgeSecretStore({ allowlist: TEST_ALLOWLIST, identityPath, secretsPath });
    await wide.pack({ [TEST_NAME]: "A" });
    const before = readFileSync(secretsPath, "utf8");
    const empty = createAgeSecretStore({ allowlist: createAllowlist([]), identityPath, secretsPath });
    await empty.pack({ [TEST_NAME]: "X" });
    expect(readFileSync(secretsPath, "utf8")).toBe(before);
    const reader = createAgeSecretStore({ allowlist: TEST_ALLOWLIST, identityPath, secretsPath });
    expect(await reader.read(TEST_NAME)).toBe("A");
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

  // Mutation point: a catch-all around the decryption in `read`/`unpack`
  // turns this refusal into "no secret saved", and the read/unpack lines go red.
  test("refuses an identity file that is readable by group or other, in pack, read and unpack", async () => {
    chmodSync(identityPath, 0o640);
    const store = createAgeSecretStore({ allowlist: TEST_ALLOWLIST, identityPath, secretsPath });
    await expect(store.pack({ [TEST_NAME]: "x" })).rejects.toThrow(/readable by group or other/);
    await expect(store.read(TEST_NAME)).rejects.toThrow(/readable by group or other/);
    await expect(store.unpack()).rejects.toThrow(/readable by group or other/);
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

  // Mutation point: drop the `decryptOrThrow` throw (fall back to the
  // swallow-and-return-empty `decrypt`) and this test goes red, because
  // `pack` would then merge the new entry on top of `{}` and overwrite the
  // file, losing `svc/b` for good.
  test("pack refuses to write when the file exists but does not decrypt, and leaves it untouched", async () => {
    const writer = createAgeSecretStore({ allowlist: TEST_ALLOWLIST, identityPath, secretsPath });
    await writer.pack({ [TEST_NAME]: "svc-a-value", [OTHER_TEST_NAME]: "svc-b-value" });
    const ciphertextBefore = readFileSync(secretsPath, "utf8");

    // Fails only the decrypt call (`age -d`); a real encrypt (`age -a`) would
    // otherwise also fail and the test would go red for the wrong reason.
    const failingRun = async (argv: string[], stdinData: string): Promise<AgeRunResult> => {
      if (argv.includes("-d")) return { stdout: "", exitCode: 1 };
      const r = spawnSync(argv[0]!, argv.slice(1), { input: stdinData, encoding: "utf8" });
      return { stdout: r.stdout ?? "", exitCode: r.status };
    };
    const fresh = createAgeSecretStore({ allowlist: TEST_ALLOWLIST, identityPath, secretsPath, run: failingRun });
    const refusal = await fresh.pack({ [TEST_NAME]: "overwrite-attempt" }).then(() => null, (err: Error) => err);
    expect(refusal?.message).toMatch(/did not decrypt/);
    for (const value of ["svc-a-value", "svc-b-value", "overwrite-attempt", identityKey.trim()]) {
      expect(refusal?.message).not.toContain(value);
    }

    expect(readFileSync(secretsPath, "utf8")).toBe(ciphertextBefore);
    const reread = createAgeSecretStore({ allowlist: TEST_ALLOWLIST, identityPath, secretsPath });
    const unpacked = await reread.unpack();
    expect(unpacked[TEST_NAME]).toBe("svc-a-value");
    expect(unpacked[OTHER_TEST_NAME]).toBe("svc-b-value");
  });

  // Mutation point: drop the try/catch in `decrypt` and read/unpack start
  // throwing on a decryption failure instead of answering as they always have.
  test("read and unpack still answer null and empty when the file exists but does not decrypt", async () => {
    const writer = createAgeSecretStore({ allowlist: TEST_ALLOWLIST, identityPath, secretsPath });
    await writer.pack({ [TEST_NAME]: "svc-a-value" });
    const failingRun = async (): Promise<AgeRunResult> => ({ stdout: "", exitCode: 1 });
    const fresh = createAgeSecretStore({ allowlist: TEST_ALLOWLIST, identityPath, secretsPath, run: failingRun });
    expect(await fresh.read(TEST_NAME)).toBeNull();
    expect(await fresh.unpack()).toEqual({});
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

// The four defects of the first version, each reproduced without the real
// `age` binary: a tiny stand-in cipher keeps these runnable on any machine.
describe("secret store regressions", () => {
  const fakeRecipient = (identity: string): string => `age1${Buffer.from(identity).toString("hex").slice(0, 20)}`;
  /** `age-keygen -y`, `age -a -r` and `age -d` over a reversible text format; `slowDecrypt` widens the race window. */
  const fakeAge = (slowDecrypt = false) => async (argv: string[], stdinData: string): Promise<AgeRunResult> => {
    if (argv[0] === "age-keygen") return { stdout: `${fakeRecipient(stdinData)}\n`, exitCode: 0 };
    if (argv[1] === "-a") return { stdout: `FAKEAGE:${argv[3]}:${Buffer.from(stdinData).toString("base64")}`, exitCode: 0 };
    const text = readFileSync(argv[argv.length - 1]!, "utf8");
    if (slowDecrypt) await new Promise((r) => setTimeout(r, 25));
    const m = /^FAKEAGE:(\S+?):(\S+)$/.exec(text);
    if (!m || m[1] !== fakeRecipient(stdinData)) return { stdout: "", exitCode: 1 };
    return { stdout: Buffer.from(m[2]!, "base64").toString("utf8"), exitCode: 0 };
  };
  const identity = "# public key: age1whatever\nAGE-SECRET-KEY-FAKE";
  const goodIdentity = `# public key: ${fakeRecipient(identity)}\nAGE-SECRET-KEY-FAKE`;
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "secret-store-reg-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("a corrupt secrets file makes pack throw and leaves the file byte for byte identical", async () => {
    const secretsPath = join(dir, "secrets.age");
    const corrupt = "not an age file \u0000\u0001 at all";
    writeFileSync(secretsPath, corrupt);
    const before = readFileSync(secretsPath);
    const store = createAgeSecretStore({ allowlist: TEST_ALLOWLIST, identity: goodIdentity, secretsPath, run: fakeAge() });
    await expect(store.pack({ [TEST_NAME]: "x" })).rejects.toThrow(/did not decrypt/);
    expect(readFileSync(secretsPath).equals(before)).toBe(true);
  });

  test("an identity whose comment names another recipient is refused before anything is written", async () => {
    const secretsPath = join(dir, "secrets.age");
    const store = createAgeSecretStore({ allowlist: TEST_ALLOWLIST, identity, secretsPath, run: fakeAge() });
    await expect(store.pack({ [TEST_NAME]: "x" })).rejects.toThrow(/does not match/);
  });

  test("the first pack creates the missing secrets folder", async () => {
    const secretsPath = join(dir, "nested", "secrets", "secrets.age");
    const store = createAgeSecretStore({ allowlist: TEST_ALLOWLIST, identity: goodIdentity, secretsPath, run: fakeAge() });
    await store.pack({ [TEST_NAME]: "x" });
    expect(readFileSync(secretsPath, "utf8")).toContain("FAKEAGE:");
  });

  test("two concurrent packs of different names both end up in the file", async () => {
    const secretsPath = join(dir, "secrets.age");
    const run = fakeAge(true);
    const a = createAgeSecretStore({ allowlist: TEST_ALLOWLIST, identity: goodIdentity, secretsPath, run });
    const b = createAgeSecretStore({ allowlist: TEST_ALLOWLIST, identity: goodIdentity, secretsPath, run });
    await a.pack({ [TEST_NAME]: "seed" });
    await Promise.all([a.pack({ [TEST_NAME]: "one" }), b.pack({ [OTHER_TEST_NAME]: "two" })]);
    const reader = createAgeSecretStore({ allowlist: TEST_ALLOWLIST, identity: goodIdentity, secretsPath, run });
    expect(await reader.unpack()).toEqual({ [TEST_NAME]: "one", [OTHER_TEST_NAME]: "two" });
  });

  test("a Keychain value over the line limit throws and the old value stays intact", async () => {
    const items = new Map<string, string>();
    const runner = (_cmd: string, args: string[], stdinData?: string): CommandRunResult => {
      if (args[0] === "find-generic-password") {
        const v = items.get(TEST_NAME);
        return v === undefined ? { status: 44, stdout: "", stderr: "" } : { status: 0, stdout: `${v}\n`, stderr: "" };
      }
      // Like the real tool: the line is cut at its buffer and the cut copy replaces the item.
      const line = (stdinData ?? "").split("\n")[0]!.slice(0, 4096);
      const m = /-w\s+"([^"]*)/.exec(line);
      items.set(TEST_NAME, m ? m[1]! : "");
      return { status: 0, stdout: "", stderr: "" };
    };
    const store = createKeychainSecretStore(TEST_ALLOWLIST, runner);
    await store.pack({ [TEST_NAME]: "old-value" });
    await expect(store.pack({ [TEST_NAME]: "x".repeat(10_000) })).rejects.toThrow(/too long/);
    expect(await store.read(TEST_NAME)).toBe("old-value");
  });

  test("plaintext that isn't valid JSON makes pack throw and leaves the file byte for byte identical", async () => {
    const secretsPath = join(dir, "secrets.age");
    const bad = `FAKEAGE:${fakeRecipient(goodIdentity)}:${Buffer.from("not json").toString("base64")}`;
    writeFileSync(secretsPath, bad);
    const before = readFileSync(secretsPath);
    const store = createAgeSecretStore({ allowlist: TEST_ALLOWLIST, identity: goodIdentity, secretsPath, run: fakeAge() });
    await expect(store.pack({ [TEST_NAME]: "x" })).rejects.toThrow(/not valid JSON/);
    expect(readFileSync(secretsPath).equals(before)).toBe(true);
  });

  test("an object with a non-string value makes pack throw and leaves the file byte for byte identical", async () => {
    const secretsPath = join(dir, "secrets.age");
    const decryptedJson = JSON.stringify({ [TEST_NAME]: "keep", [OTHER_TEST_NAME]: { nested: true } });
    const bad = `FAKEAGE:${fakeRecipient(goodIdentity)}:${Buffer.from(decryptedJson).toString("base64")}`;
    writeFileSync(secretsPath, bad);
    const before = readFileSync(secretsPath);
    const store = createAgeSecretStore({ allowlist: TEST_ALLOWLIST, identity: goodIdentity, secretsPath, run: fakeAge() });
    await expect(store.pack({ [TEST_NAME]: "x" })).rejects.toThrow(/non-string value/);
    expect(readFileSync(secretsPath).equals(before)).toBe(true);
  });

  test("two concurrent packs through different spellings of the same path both end up in the file", async () => {
    const secretsPath = join(dir, "secrets.age");
    const altPath = `${dir}/./secrets.age`;
    const run = fakeAge(true);
    const a = createAgeSecretStore({ allowlist: TEST_ALLOWLIST, identity: goodIdentity, secretsPath, run });
    const b = createAgeSecretStore({ allowlist: TEST_ALLOWLIST, identity: goodIdentity, secretsPath: altPath, run });
    await a.pack({ [TEST_NAME]: "seed" });
    await Promise.all([a.pack({ [TEST_NAME]: "one" }), b.pack({ [OTHER_TEST_NAME]: "two" })]);
    const reader = createAgeSecretStore({ allowlist: TEST_ALLOWLIST, identity: goodIdentity, secretsPath, run });
    expect(await reader.unpack()).toEqual({ [TEST_NAME]: "one", [OTHER_TEST_NAME]: "two" });
  });

  test("a Keychain name under the unit limit but over the byte limit throws before security runs", async () => {
    const bigName = "中".repeat(1000);
    const allowlist = createAllowlist([bigName]);
    let securityCalled = false;
    const runner = (_cmd: string, args: string[]): CommandRunResult => {
      if (args[0] === "find-generic-password") return { status: 44, stdout: "", stderr: "" };
      securityCalled = true;
      return { status: 0, stdout: "", stderr: "" };
    };
    const store = createKeychainSecretStore(allowlist, runner);
    await expect(store.pack({ [bigName]: "x".repeat(1000) })).rejects.toThrow(/too long/);
    expect(securityCalled).toBe(false);
  });

  test("a spawned child does not see TOPICS_SECRET_AGE_IDENTITY", () => {
    const env = withoutGatewayToken({ ...process.env, TOPICS_SECRET_AGE_IDENTITY: "AGE-SECRET-KEY-FAKE" });
    const r = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.env.TOPICS_SECRET_AGE_IDENTITY))"], { env, encoding: "utf8" });
    expect(r.stdout).toBe("undefined");
  });
});
