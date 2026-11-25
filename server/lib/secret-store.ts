/**
 * One "read a secret" interface, backed by two implementations that store
 * the SAME closed list of names: the macOS Keychain, and an age-encrypted
 * file on every other platform (the server this fleet runs on once it
 * becomes the primary, `nodo-principale-a-mano` T3). Callers never know
 * which one answered: they ask for `keychain:<service>/<use>`, the same key
 * jarvis-channels already reads on the Mac.
 *
 * No real secret of this fleet is packed by this task; the acceptance bar
 * exercises a test value only. Nothing here writes a value to a log or to
 * the SQLite DB: the only writes are the two dedicated files below, and
 * every rejection path reports the NAME, never the value that came with it.
 *
 * The age identity (the private key) is read once, lazily, into memory and
 * cached there; this module never writes it back to disk and never derives
 * it. Provisioning that file is out of scope here, so the default path
 * points at a file that does not exist until someone puts it there, and the
 * store simply answers empty until it does.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-write";
import { resolveStateDir } from "./data-dir";
import { runBounded, SPAWN_TIMEOUT } from "./bounded-spawn";

/** The closed list this fleet actually needs, decided in T3 (no Claude API key: that is T2's job). */
export const SECRET_NAMES = [
  "keychain:discord/bot-token",
  "keychain:topics/agent-token",
  "keychain:claude/git-crypt-key",
  "keychain:hetzner/token",
  "keychain:cloudflare/token",
  "keychain:billing/token",
  "keychain:litestream/age-key",
] as const;

export type SecretName = typeof SECRET_NAMES[number];
export type SecretMap = Partial<Record<SecretName, string>>;

const NAME_SET: ReadonlySet<string> = new Set(SECRET_NAMES);

export function isKnownSecretName(name: string): name is SecretName {
  return NAME_SET.has(name);
}

export interface SecretStore {
  /** Null for an unknown name (logged by name only) or one never packed. */
  read(name: SecretName): Promise<string | null>;
  /** Unknown names are refused one by one; the rest of the call still packs. */
  pack(entries: SecretMap): Promise<void>;
  unpack(): Promise<SecretMap>;
}

// --- macOS: one generic-password item per name, under a fixed service. ---

export interface CommandRunResult { status: number; stdout: string; stderr: string }
export type CommandRunner = (cmd: string, args: string[]) => CommandRunResult;

const KEYCHAIN_SERVICE = "topics-secrets";

const defaultCommandRunner: CommandRunner = (cmd, args) => {
  const r = Bun.spawnSync([cmd, ...args], { stdout: "pipe", stderr: "pipe" });
  return { status: r.exitCode ?? 1, stdout: r.stdout.toString("utf8"), stderr: r.stderr.toString("utf8") };
};

function keychainFind(runner: CommandRunner, name: string): string | null {
  const r = runner("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", name, "-w"]);
  return r.status === 0 ? r.stdout.replace(/\n$/, "") : null;
}

export function createKeychainSecretStore(runner: CommandRunner = defaultCommandRunner): SecretStore {
  return {
    async read(name) {
      if (!isKnownSecretName(name)) { console.warn("[secret-store] rejected an unknown name"); return null; }
      return keychainFind(runner, name);
    },
    async pack(entries) {
      for (const [name, value] of Object.entries(entries)) {
        if (!isKnownSecretName(name)) { console.warn(`[secret-store] refused to pack an unknown name: "${name}"`); continue; }
        if (value === undefined) continue;
        const r = runner("security", ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", name, "-w", value]);
        if (r.status !== 0) throw new Error(`keychain write failed for "${name}": exit ${r.status}`);
      }
    },
    async unpack() {
      const out: SecretMap = {};
      for (const name of SECRET_NAMES) {
        const value = keychainFind(runner, name);
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

/**
 * Trusts the ciphertext to hold only allowlisted names: `pack` is the one
 * place that decides what gets persisted (see its guard below), so the
 * closed list is enforced once, not twice.
 */
function parseSecretMap(json: string): SecretMap {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return {}; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: SecretMap = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "string") out[name as SecretName] = value;
  }
  return out;
}

export interface AgeSecretStoreOptions {
  /** Unlocked lazily, once, into memory; never rewritten by this module. */
  identityPath: string;
  /** Where the packed, encrypted map lives. */
  secretsPath: string;
  run?: AgeRunner;
}

export function createAgeSecretStore(opts: AgeSecretStoreOptions): SecretStore {
  const run = opts.run ?? defaultAgeRunner;
  let cachedIdentity: string | null = null;
  const identity = (): string | null => {
    if (cachedIdentity !== null) return cachedIdentity;
    if (!existsSync(opts.identityPath)) return null;
    cachedIdentity = readFileSync(opts.identityPath, "utf8");
    return cachedIdentity;
  };

  const unpack = async (): Promise<SecretMap> => {
    if (!identity() || !existsSync(opts.secretsPath)) return {};
    const ciphertext = readFileSync(opts.secretsPath, "utf8");
    const { stdout, exitCode } = await run(["age", "-d", "-i", opts.identityPath], ciphertext);
    if (exitCode !== 0 || !stdout.trim()) return {};
    return parseSecretMap(stdout);
  };

  return {
    async read(name) {
      if (!isKnownSecretName(name)) { console.warn("[secret-store] rejected an unknown name"); return null; }
      return (await unpack())[name] ?? null;
    },
    async pack(entries) {
      const id = identity();
      if (!id) throw new Error("age identity is not unlocked: nothing was packed");
      const recipient = recipientFromIdentity(id);
      if (!recipient) throw new Error("age identity file has no public-key comment");
      const next: SecretMap = { ...(await unpack()) };
      for (const [name, value] of Object.entries(entries)) {
        if (!isKnownSecretName(name)) { console.warn(`[secret-store] refused to pack an unknown name: "${name}"`); continue; }
        if (value !== undefined) next[name] = value;
      }
      const { stdout, exitCode } = await run(["age", "-a", "-r", recipient], JSON.stringify(next));
      if (exitCode !== 0 || !stdout) throw new Error("age encryption failed");
      writeFileAtomic(opts.secretsPath, stdout, { mode: 0o600 });
    },
    unpack,
  };
}

export interface CreateSecretStoreOptions {
  platform?: NodeJS.Platform;
  stateDir?: string;
  identityPath?: string;
  secretsPath?: string;
}

/** Picks the backend by platform; every path below has a generic default that works empty. */
export function createSecretStore(opts: CreateSecretStoreOptions = {}): SecretStore {
  const platform = opts.platform ?? process.platform;
  if (platform === "darwin") return createKeychainSecretStore();
  const dir = join(opts.stateDir ?? resolveStateDir(process.cwd()), "secrets");
  return createAgeSecretStore({
    identityPath: opts.identityPath ?? (process.env.TOPICS_SECRET_AGE_IDENTITY || join(dir, "identity.age-key")),
    secretsPath: opts.secretsPath ?? join(dir, "secrets.age"),
  });
}
