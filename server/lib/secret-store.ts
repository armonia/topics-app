/**
 * One "read a secret" interface, backed by two implementations: the macOS
 * Keychain, and an age-encrypted file on every other platform (the server
 * this fleet runs on once it becomes the primary, `nodo-principale-a-mano`
 * T3). Callers never know which one answered: they ask for
 * `keychain:<service>/<use>`, the same key jarvis-channels already reads on
 * the Mac.
 *
 * The closed list of names an installation accepts is NOT in this file
 * (regola zero: this source ships to every installation). It comes from the
 * caller, or from `<stateDir>/secrets/allowed-secret-names.json` by default —
 * missing or empty, the store rejects every name, which is the safe default.
 * No real secret of this fleet is packed by this task; the acceptance bar
 * exercises a test value and a test allowlist only.
 *
 * Nothing here writes a value to a log, to the SQLite DB, or to a process's
 * argv: the macOS write goes through `security -i` (interactive mode reads
 * its command from stdin, never from argv, so `ps` never sees it during the
 * call), and what it stores is never the raw value but `b64:<base64>` — a
 * printable one-line form, so a multi-line value (an age identity is several
 * lines) can neither close the `-i` command early and smuggle a second one
 * in, nor make `security -w` answer in hex on the way back out. The age
 * identity travels to `age` the same way, via stdin, never as a `-i <path>`
 * argument. Every rejection path reports the NAME, never the value that came
 * with it.
 *
 * The age identity (the private key) is sourced once, lazily, from
 * `$CREDENTIALS_DIRECTORY` (systemd `LoadCredentialEncrypted=`, a tmpfs
 * mount that is gone once the unit stops) or from an environment variable
 * holding the key material itself; an explicit file path is accepted for
 * manual/dev use only, and is refused if its permissions let anyone but its
 * owner read it. Whichever source answers, the material stays in memory for
 * the life of the store and this module never writes it back to disk.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-write";
import { resolveStateDir } from "./data-dir";
import { runBounded, SPAWN_TIMEOUT } from "./bounded-spawn";

export type SecretName = string;
export type SecretMap = Record<string, string>;

export interface SecretStore {
  /** Null for a name outside the allowlist (logged by name only) or one never packed. */
  read(name: SecretName): Promise<string | null>;
  /** Names outside the allowlist are refused one by one; the rest of the call still packs. */
  pack(entries: Partial<SecretMap>): Promise<void>;
  unpack(): Promise<SecretMap>;
}

/** The closed list a single installation accepts; `names` backs enumeration for the Keychain backend. */
export interface SecretAllowlist {
  readonly names: readonly string[];
  has(name: string): boolean;
}

/** True for a byte the `security -i` tokenizer or its hex output would treat specially (newline above all). */
export function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function createAllowlist(names: Iterable<string>): SecretAllowlist {
  // A name reaches the `security -i` command line quoted, so a control
  // character in one would be an injection the same way a value would: such a
  // name is never allowed, however the config got it.
  const list = Array.from(new Set(names)).filter((name) => !hasControlCharacter(name));
  const set = new Set(list);
  return { names: list, has: (name) => set.has(name) };
}

const EMPTY_ALLOWLIST: SecretAllowlist = createAllowlist([]);

const ALLOWED_NAMES_FILE = "allowed-secret-names.json";

/** Reads the installation's own list from its state dir; a missing or malformed file answers empty, never a guess. */
export function loadAllowlistFromStateDir(stateDir: string): SecretAllowlist {
  const path = join(stateDir, "secrets", ALLOWED_NAMES_FILE);
  if (!existsSync(path)) return EMPTY_ALLOWLIST;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (Array.isArray(parsed) && parsed.every((n) => typeof n === "string")) return createAllowlist(parsed);
  } catch { /* malformed config answers empty, same as missing */ }
  return EMPTY_ALLOWLIST;
}

// --- macOS: one generic-password item per name, under a fixed service. ---

export interface CommandRunResult { status: number; stdout: string; stderr: string }
export type CommandRunner = (cmd: string, args: string[], stdinData?: string) => CommandRunResult;

const KEYCHAIN_SERVICE = "topics-secrets";
const COMMAND_TIMEOUT_MS = 15_000;

const defaultCommandRunner: CommandRunner = (cmd, args, stdinData) => {
  const r = Bun.spawnSync([cmd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: COMMAND_TIMEOUT_MS,
    stdin: stdinData === undefined ? undefined : Buffer.from(stdinData, "utf8"),
  });
  return { status: r.exitCode ?? 1, stdout: r.stdout.toString("utf8"), stderr: r.stderr.toString("utf8") };
};

/**
 * Everything this store writes to the Keychain is `b64:<base64>`, and
 * nothing else is ever read back as a value. Two reasons, both measured on a
 * real Keychain: base64 has no quote, backslash or newline, so a multi-line
 * value cannot break out of the one-command-per-line stdin of `security -i`;
 * and it is all printable, so `security find-generic-password -w` answers
 * with the text itself instead of switching to its hex output (which it does
 * as soon as the stored data holds a byte below 0x20, handing the caller
 * hex digits where it expected the secret).
 */
const PAYLOAD_PREFIX = "b64:";
const PAYLOAD_SHAPE = /^b64:[A-Za-z0-9+/]*={0,2}$/;

function encodePayload(value: string): string {
  const payload = PAYLOAD_PREFIX + Buffer.from(value, "utf8").toString("base64");
  // The quoting below is only safe because of this shape: assert it rather
  // than trust it.
  if (!PAYLOAD_SHAPE.test(payload)) throw new Error("secret payload is not in the expected printable form");
  return payload;
}

/** An entry without the prefix was not written by this store, so it is an error, not a value. No "looks like hex" guessing. */
function decodePayload(raw: string, name: string): string {
  if (!raw.startsWith(PAYLOAD_PREFIX)) throw new Error(`secret "${name}" was not written by this store (missing payload prefix)`);
  return Buffer.from(raw.slice(PAYLOAD_PREFIX.length), "base64").toString("utf8");
}

/** The stored text as the Keychain holds it; decoding is the caller's step. */
function keychainFindRaw(runner: CommandRunner, name: string): string | null {
  const r = runner("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", name, "-w"]);
  return r.status === 0 ? r.stdout.replace(/\n$/, "") : null;
}

function keychainRead(runner: CommandRunner, name: string): string | null {
  const raw = keychainFindRaw(runner, name);
  return raw === null ? null : decodePayload(raw, name);
}

/** Mirrors `security -i`'s own tokenizer: double-quoted words, backslash escapes inside them. */
function quoteForSecurityStdin(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * `security`'s interactive mode reads one command per line from stdin and
 * never places it in argv, so the secret value never reaches `ps` for the
 * life of the call. This is the only path `pack` uses to write a value.
 */
function keychainAdd(runner: CommandRunner, name: string, value: string): CommandRunResult {
  const command = [
    "add-generic-password", "-U",
    "-s", quoteForSecurityStdin(KEYCHAIN_SERVICE),
    "-a", quoteForSecurityStdin(name),
    "-w", quoteForSecurityStdin(encodePayload(value)),
  ].join(" ");
  return runner("security", ["-i"], `${command}\n`);
}

export function createKeychainSecretStore(allowlist: SecretAllowlist, runner: CommandRunner = defaultCommandRunner): SecretStore {
  return {
    async read(name) {
      if (!allowlist.has(name)) { console.warn("[secret-store] rejected a name outside the allowlist"); return null; }
      return keychainRead(runner, name);
    },
    async pack(entries) {
      for (const [name, value] of Object.entries(entries)) {
        if (!allowlist.has(name)) { console.warn("[secret-store] refused to pack a name outside the allowlist"); continue; }
        if (value === undefined) continue;
        const r = keychainAdd(runner, name, value);
        if (r.status !== 0) throw new Error(`keychain write failed for "${name}": exit ${r.status}`);
      }
    },
    async unpack() {
      const out: SecretMap = {};
      for (const name of allowlist.names) {
        const value = keychainRead(runner, name);
        if (value !== null) out[name] = value;
      }
      return out;
    },
  };
}

// --- Everywhere else: one age-encrypted file holding the whole map. ---

export interface AgeRunResult { stdout: string; exitCode: number | null }
export type AgeRunner = (argv: string[], stdinData: string) => Promise<AgeRunResult>;

const defaultAgeRunner: AgeRunner = async (argv, stdinData) => {
  const r = await runBounded(argv, { stdinData, timeoutMs: SPAWN_TIMEOUT.query });
  return { stdout: r.stdout, exitCode: r.exitCode };
};

/** `age-keygen` writes this comment above the key it generated. */
function recipientFromIdentity(identity: string): string | null {
  const m = /^# public key:\s*(age1\S+)/m.exec(identity);
  return m ? m[1] : null;
}

/** Parses the whole ciphertext content without filtering: the gate is on the outputs (`read`, `unpack`) and on `pack`. */
function parseSecretMap(json: string): SecretMap {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return {}; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: SecretMap = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "string") out[name] = value;
  }
  return out;
}

const CREDENTIALS_DIR_ENV = "CREDENTIALS_DIRECTORY";
const IDENTITY_CREDENTIAL_NAME = "secret-store-identity";
const IDENTITY_ENV_NAME = "TOPICS_SECRET_AGE_IDENTITY";

/** A file readable by anyone but its owner is refused outright: never trusted as an identity source. */
function readIdentityFile(path: string): string {
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) throw new Error(`refusing identity file "${path}": readable by group or other (mode ${mode.toString(8)})`);
  return readFileSync(path, "utf8");
}

/**
 * In order: key material handed in directly, the env var holding the
 * material itself, `$CREDENTIALS_DIRECTORY` (systemd's decrypted-at-startup
 * tmpfs credential), then an explicit path for manual/dev use. No source
 * here is a default that points at a real, pre-existing file: an
 * unprovisioned installation answers null.
 */
function resolveIdentity(opts: AgeSecretStoreOptions): string | null {
  if (opts.identity) return opts.identity;
  const envValue = process.env[IDENTITY_ENV_NAME];
  if (envValue) return envValue;
  const credentialsDir = process.env[CREDENTIALS_DIR_ENV];
  if (credentialsDir) {
    const credentialPath = join(credentialsDir, IDENTITY_CREDENTIAL_NAME);
    if (existsSync(credentialPath)) return readIdentityFile(credentialPath);
  }
  if (opts.identityPath && existsSync(opts.identityPath)) return readIdentityFile(opts.identityPath);
  return null;
}

export interface AgeSecretStoreOptions {
  allowlist: SecretAllowlist;
  /** Key material already unlocked by the caller; takes priority over every other source. */
  identity?: string;
  /** Manual/dev fallback only; permissions are checked, see `readIdentityFile`. */
  identityPath?: string;
  /** Where the packed, encrypted map lives. */
  secretsPath: string;
  run?: AgeRunner;
}

export function createAgeSecretStore(opts: AgeSecretStoreOptions): SecretStore {
  const run = opts.run ?? defaultAgeRunner;
  let cachedIdentity: string | null = null;
  let identityResolved = false;
  const identity = (): string | null => {
    if (identityResolved) return cachedIdentity;
    cachedIdentity = resolveIdentity(opts);
    identityResolved = true;
    return cachedIdentity;
  };

  /** The decrypted map, kept after the first `unpack`; `pack` replaces it with the fresh truth instead of leaving it stale. */
  let cachedMap: SecretMap | null = null;

  /**
   * Throws when the file exists but did not decrypt (bad exit, timeout, wrong
   * identity): a caller that would otherwise merge on top of this result —
   * `pack` — must never treat that failure as "no secrets yet" and overwrite
   * the file with only what it just packed.
   */
  const decryptOrThrow = async (): Promise<SecretMap> => {
    if (cachedMap) return cachedMap;
    const id = identity();
    if (!id || !existsSync(opts.secretsPath)) return {};
    // Identity travels via stdin ("-i -"); the ciphertext path is the only
    // thing age sees in its argv, and that path carries no secret.
    const { stdout, exitCode } = await run(["age", "-d", "-i", "-", opts.secretsPath], id);
    if (exitCode !== 0 || !stdout.trim()) {
      throw new Error(`secrets file exists but did not decrypt (age exited ${exitCode})`);
    }
    // The WHOLE file map: names outside the current allowlist stay in it, so a
    // narrower store never destroys them on rewrite. The outputs filter instead.
    cachedMap = parseSecretMap(stdout);
    return cachedMap;
  };

  /** Same decryption, but a failure answers empty: the behaviour `read`/`unpack` have always had. */
  const decrypt = async (): Promise<SecretMap> => {
    try {
      return await decryptOrThrow();
    } catch {
      return {};
    }
  };

  return {
    async read(name) {
      if (!opts.allowlist.has(name)) { console.warn("[secret-store] rejected a name outside the allowlist"); return null; }
      return (await decrypt())[name] ?? null;
    },
    async pack(entries) {
      const id = identity();
      if (!id) throw new Error("age identity is not unlocked: nothing was packed");
      const recipient = recipientFromIdentity(id);
      if (!recipient) throw new Error("age identity has no public-key comment");
      const next: SecretMap = { ...(await decryptOrThrow()) };
      let changed = false;
      for (const [name, value] of Object.entries(entries)) {
        if (!opts.allowlist.has(name)) { console.warn("[secret-store] refused to pack a name outside the allowlist"); continue; }
        if (value !== undefined) { next[name] = value; changed = true; }
      }
      // Nothing admitted: leave the file untouched instead of rewriting it.
      if (!changed) return;
      const { stdout, exitCode } = await run(["age", "-a", "-r", recipient], JSON.stringify(next));
      if (exitCode !== 0 || !stdout) throw new Error("age encryption failed");
      writeFileAtomic(opts.secretsPath, stdout, { mode: 0o600 });
      cachedMap = next;
    },
    async unpack() {
      const out: SecretMap = {};
      for (const [name, value] of Object.entries(await decrypt())) {
        if (opts.allowlist.has(name)) out[name] = value;
      }
      return out;
    },
  };
}

export interface CreateSecretStoreOptions {
  platform?: NodeJS.Platform;
  stateDir?: string;
  allowlist?: SecretAllowlist;
  identity?: string;
  identityPath?: string;
  secretsPath?: string;
}

/** Picks the backend by platform; every default below is generic and answers empty until someone provisions it. */
export function createSecretStore(opts: CreateSecretStoreOptions = {}): SecretStore {
  const platform = opts.platform ?? process.platform;
  const stateDir = opts.stateDir ?? resolveStateDir(process.cwd());
  const allowlist = opts.allowlist ?? loadAllowlistFromStateDir(stateDir);
  if (platform === "darwin") return createKeychainSecretStore(allowlist);
  return createAgeSecretStore({
    allowlist,
    identity: opts.identity,
    identityPath: opts.identityPath,
    secretsPath: opts.secretsPath ?? join(stateDir, "secrets", "secrets.age"),
  });
}
