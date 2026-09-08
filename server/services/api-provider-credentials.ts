import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveStateDir } from "../lib/data-dir";

export type ApiProviderName = "openai" | "claude";
type Credentials = Partial<Record<ApiProviderName, string>>;
const ENV_KEYS = { openai: "OPENAI_API_KEY", claude: "ANTHROPIC_API_KEY" } as const;
let configuredRoot: string | undefined;

/** The server supplies its canonical writable root before provider bootstrap.
 * Autodiscovery and subsequent CLI reconfiguration must use that same root. */
export function configureApiCredentialRoot(root: string): void { configuredRoot = root; }
function stateRoot(): string { return configuredRoot ?? resolveStateDir(process.cwd()); }

// Installation credentials live outside the public bundle and public settings.
// Resolve through the same state root as the DB so test servers stay isolated.
function directory(root: string): string { return join(root, ".topics-secrets"); }

function read(root: string): Credentials {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(directory(root), "providers.json"), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    const result: Credentials = {};
    for (const name of ["openai", "claude"] as const) {
      const value = (parsed as Record<string, unknown>)[name];
      if (value !== undefined && (typeof value !== "string" || !value.trim())) throw new Error();
      if (typeof value === "string") result[name] = value;
    }
    return result;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("Cannot read saved API credentials on this server.");
  }
}

export function readApiProviderKey(
  name: ApiProviderName,
  root = stateRoot(),
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  try {
    return read(root)[name] ?? (env[ENV_KEYS[name]]?.trim() || undefined);
  } catch {
    // A damaged local store must not prevent independent CLI providers booting.
    console.warn("[Providers] Saved API credentials are unreadable; check the private server file.");
    return env[ENV_KEYS[name]]?.trim() || undefined;
  }
}

export function saveApiProviderKey(name: ApiProviderName, key: string, root = stateRoot()): void {
  const credentials = read(root);
  const dir = directory(root);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const temp = join(dir, `providers-${crypto.randomUUID()}.tmp`);
  try {
    writeFileSync(temp, JSON.stringify({ ...credentials, [name]: key }), { mode: 0o600, flag: "wx" });
    renameSync(temp, join(dir, "providers.json"));
  } catch {
    throw new Error("Cannot save the API key on this server.");
  } finally {
    try { unlinkSync(temp); } catch { /* renamed or never created */ }
  }
}
