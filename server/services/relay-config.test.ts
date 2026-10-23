/**
 * The machine's relay key on disk: a restart keeps the name, the previous scheme's file is left as
 * it was, and the keys live in the secrets folder, not in the state root.
 *
 * Each test below is a way a lost or exposed key would pass for a good one: a key that moved and was
 * regenerated instead (every link and paired device breaks), a key overwritten because it could not be
 * read for a moment, a key left in the root that `/preview` serves.
 *
 * @covers RELAY-E2E-12
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { leggiInstallationId, leggiRelayConfig, leggiRelaySegreto } from "./relay-config";

const made: string[] = [];
const prevSecretsDir = process.env.TOPICS_SECRETS_DIR;

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-config-"));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (prevSecretsDir === undefined) delete process.env.TOPICS_SECRETS_DIR;
  else process.env.TOPICS_SECRETS_DIR = prevSecretsDir;
});

const mode = (path: string): number => statSync(path).mode & 0o777;
const legacyIdentity = JSON.stringify({ relayId: "relay-id-known", segreto: "secret-known" }) + "\n";

/**
 * Runs the readers in a process that is NOT a test run: the only kind that honours the pin, and the
 * only way to have several first boots really at once.
 */
async function inLiveProcess(stateDir: string, pin?: string): Promise<string> {
  const code = `import { leggiRelayConfig } from ${JSON.stringify(join(import.meta.dir, "relay-config.ts"))};` +
    "console.log((await leggiRelayConfig({}, process.env.STATE_UNDER_TEST!)).relayId);";
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", STATE_UNDER_TEST: stateDir };
  if (pin) env.TOPICS_SECRETS_DIR = pin;
  const child = Bun.spawn([process.execPath, "-e", code], { env, stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(child.stdout).text()).trim();
  if ((await child.exited) !== 0) throw new Error(`reader process failed: ${await new Response(child.stderr).text()}`);
  return out;
}

describe("relay identity on disk", () => {
  test("the previous scheme's relay-secret stays as it was, and the new identity survives a reboot", async () => {
    delete process.env.TOPICS_SECRETS_DIR;
    const dir = tmp();
    const legacy = "legacy-shared-secret-abcdefghijklmnop\n";
    writeFileSync(join(dir, "relay-secret"), legacy);
    const first = await leggiRelayConfig({}, dir);
    expect(readFileSync(join(dir, "relay-secret"), "utf8")).toBe(legacy);
    const secrets = join(dir, ".topics-secrets");
    const file = join(secrets, "relay-identity.json");
    expect(existsSync(file)).toBe(true);
    expect(mode(file)).toBe(0o600);
    expect(mode(secrets)).toBe(0o700);
    // No key may sit in the state root: the preview route would expose it.
    expect(existsSync(join(dir, "relay-identity.json"))).toBe(false);
    expect(existsSync(join(dir, "installation-id"))).toBe(false);
    // The next boot reads the same identity: the links keep their meeting point.
    expect((await leggiRelayConfig({}, dir)).relayId).toBe(first.relayId);
    expect(await leggiRelaySegreto(dir)).toBe((JSON.parse(readFileSync(file, "utf8")) as { segreto: string }).segreto);
  });

  test("a key still in the state root is moved, not regenerated", async () => {
    delete process.env.TOPICS_SECRETS_DIR;
    const dir = tmp();
    writeFileSync(join(dir, "relay-identity.json"), legacyIdentity, { mode: 0o644 });
    writeFileSync(join(dir, "installation-id"), "install-id-known-1234\n", { mode: 0o644 });
    const config = await leggiRelayConfig({}, dir);
    expect(config.relayId).toBe("relay-id-known");
    expect(config.installationId).toBe("install-id-known-1234");
    expect(await leggiRelaySegreto(dir)).toBe("secret-known");
    const secrets = join(dir, ".topics-secrets");
    expect(readFileSync(join(secrets, "relay-identity.json"), "utf8")).toBe(legacyIdentity);
    expect(mode(join(secrets, "relay-identity.json"))).toBe(0o600);
    expect(mode(join(secrets, "installation-id"))).toBe(0o600);
    expect(mode(secrets)).toBe(0o700);
    // A rename leaves no copy behind in the root.
    expect(existsSync(join(dir, "relay-identity.json"))).toBe(false);
    expect(existsSync(join(dir, "installation-id"))).toBe(false);
  });

  test("when the new file already exists it wins and the old one is left byte for byte", async () => {
    delete process.env.TOPICS_SECRETS_DIR;
    const dir = tmp();
    const secrets = join(dir, ".topics-secrets");
    mkdirSync(secrets, { mode: 0o700 });
    const current = JSON.stringify({ relayId: "relay-id-current", segreto: "secret-current" }) + "\n";
    writeFileSync(join(secrets, "relay-identity.json"), current, { mode: 0o600 });
    writeFileSync(join(dir, "relay-identity.json"), legacyIdentity);
    expect((await leggiRelayConfig({}, dir)).relayId).toBe("relay-id-current");
    expect(readFileSync(join(secrets, "relay-identity.json"), "utf8")).toBe(current);
    expect(readFileSync(join(dir, "relay-identity.json"), "utf8")).toBe(legacyIdentity);
  });

  test("TOPICS_SECRETS_DIR moves the keys out of the state root altogether, for the live server", async () => {
    const dir = tmp();
    const keys = join(tmp(), "keys");
    writeFileSync(join(dir, "relay-identity.json"), legacyIdentity);
    expect(await inLiveProcess(dir, keys)).toBe("relay-id-known");
    expect(readFileSync(join(keys, "relay-identity.json"), "utf8")).toBe(legacyIdentity);
    expect(mode(keys)).toBe(0o700);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a test run ignores the pin it inherited and keeps its keys in its own state", async () => {
    const dir = tmp();
    const keys = join(tmp(), "keys");
    process.env.TOPICS_SECRETS_DIR = keys;
    await leggiRelayConfig({}, dir);
    expect(existsSync(join(dir, ".topics-secrets", "relay-identity.json"))).toBe(true);
    expect(existsSync(keys)).toBe(false);
  });

  test("six first boots at once agree on one identity, and it is the one on disk", async () => {
    const dir = tmp();
    const seen = await Promise.all(Array.from({ length: 6 }, () => inLiveProcess(dir)));
    const onDisk = (JSON.parse(readFileSync(join(dir, ".topics-secrets", "relay-identity.json"), "utf8")) as { relayId: string }).relayId;
    expect(new Set(seen)).toEqual(new Set([onDisk]));
  });

  test("a broken secrets folder does not hide the key that is still in the root", async () => {
    delete process.env.TOPICS_SECRETS_DIR;
    const dir = tmp();
    // `.topics-secrets` is a FILE: the folder cannot be made, so the key cannot move.
    writeFileSync(join(dir, ".topics-secrets"), "in the way");
    writeFileSync(join(dir, "relay-identity.json"), legacyIdentity);
    expect((await leggiRelayConfig({}, dir)).relayId).toBe("relay-id-known");
    expect(readFileSync(join(dir, "relay-identity.json"), "utf8")).toBe(legacyIdentity);
  });
});

// Write-only (0200) is the one failure a test can stage where the read fails and the write WOULD
// succeed, which is exactly the case a careless regeneration turns into a lost key (EMFILE, EACCES).
// Root reads it anyway, so there is nothing to stage.
const asRoot = process.getuid?.() === 0;

describe("a key that cannot be read is never overwritten", () => {
  test.skipIf(asRoot)("an unreadable identity keeps its bytes; a corrupt one is set aside, not erased", async () => {
    delete process.env.TOPICS_SECRETS_DIR;
    const blocked = tmp();
    const secrets = join(blocked, ".topics-secrets");
    mkdirSync(secrets, { mode: 0o700 });
    const file = join(secrets, "relay-identity.json");
    writeFileSync(file, legacyIdentity, { mode: 0o200 });
    chmodSync(file, 0o200);
    const temporary = await leggiRelayConfig({}, blocked);
    expect(temporary.relayId).not.toBe("relay-id-known");
    chmodSync(file, 0o600);
    expect(readFileSync(file, "utf8")).toBe(legacyIdentity);

    // A truncated file is not a key, but it may be the only copy of one: it is kept under another name.
    const corrupt = tmp();
    const corruptSecrets = join(corrupt, ".topics-secrets");
    mkdirSync(corruptSecrets, { mode: 0o700 });
    writeFileSync(join(corruptSecrets, "relay-identity.json"), '{"relayId":"half');
    const regenerated = await leggiRelayConfig({}, corrupt);
    const aside = readdirSync(corruptSecrets).find((n) => n.startsWith("relay-identity.json.corrupt-"));
    expect(aside).toBeDefined();
    expect(readFileSync(join(corruptSecrets, aside!), "utf8")).toBe('{"relayId":"half');
    expect((JSON.parse(readFileSync(join(corruptSecrets, "relay-identity.json"), "utf8")) as { relayId: string }).relayId).toBe(regenerated.relayId);
  });

  test.skipIf(asRoot)("the installation id follows the same rule", () => {
    delete process.env.TOPICS_SECRETS_DIR;
    const blocked = tmp();
    const secrets = join(blocked, ".topics-secrets");
    mkdirSync(secrets, { mode: 0o700 });
    const file = join(secrets, "installation-id");
    writeFileSync(file, "install-id-known-1234\n", { mode: 0o200 });
    chmodSync(file, 0o200);
    expect(leggiInstallationId(blocked)).not.toBe("install-id-known-1234");
    chmodSync(file, 0o600);
    expect(readFileSync(file, "utf8")).toBe("install-id-known-1234\n");

    const garbled = tmp();
    const garbledSecrets = join(garbled, ".topics-secrets");
    mkdirSync(garbledSecrets, { mode: 0o700 });
    writeFileSync(join(garbledSecrets, "installation-id"), "not a valid id !!\n");
    const fresh = leggiInstallationId(garbled);
    expect(fresh).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(readdirSync(garbledSecrets).some((n) => n.startsWith("installation-id.corrupt-"))).toBe(true);
    expect(leggiInstallationId(garbled)).toBe(fresh);
  });
});

describe("a key that is there is never replaced by another", () => {
  test.skipIf(asRoot)("a secrets folder without the x bit does not make adoption overwrite the new key", async () => {
    const dir = tmp();
    const secrets = join(dir, ".topics-secrets");
    mkdirSync(secrets, { mode: 0o700 });
    const current = JSON.stringify({ relayId: "relay-id-current", segreto: "secret-current" }) + "\n";
    writeFileSync(join(secrets, "relay-identity.json"), current, { mode: 0o600 });
    writeFileSync(join(dir, "relay-identity.json"), legacyIdentity);
    chmodSync(secrets, 0o600);
    expect((await leggiRelayConfig({}, dir)).relayId).toBe("relay-id-current");
    chmodSync(secrets, 0o700);
    expect(readFileSync(join(secrets, "relay-identity.json"), "utf8")).toBe(current);
  });

  test.skipIf(asRoot)("a corrupt key that cannot be set aside is not written over", async () => {
    const dir = tmp();
    const secrets = join(dir, ".topics-secrets");
    mkdirSync(secrets, { mode: 0o700 });
    const file = join(secrets, "relay-identity.json");
    writeFileSync(file, '{"relayId":"truncated', { mode: 0o600 });
    chmodSync(secrets, 0o500);
    expect((await leggiRelayConfig({}, dir)).relayId).toMatch(/./);
    chmodSync(secrets, 0o700);
    expect(readFileSync(file, "utf8")).toBe('{"relayId":"truncated');
    expect(readdirSync(secrets).filter((n) => n.includes("corrupt"))).toEqual([]);
  });
});
