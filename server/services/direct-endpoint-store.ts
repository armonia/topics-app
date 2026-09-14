/**
 * Where configured OpenAI-compatible endpoints live.
 *
 * A plain state file, `<STATE_DIR>/direct-endpoints.json`, written tmp + rename.
 * Not a table: there is no migration to run, and a damaged file degrades to
 * "no endpoints configured" instead of standing between the server and its boot.
 *
 * The bearer token is NOT in `.topics-secrets/providers.json`. That file's
 * reader rebuilds the object with the `openai` and `claude` keys only, so the
 * next key save would drop anything else written next to them. It gets a
 * sibling file of its own, 0600, keyed by endpoint id.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveStateDir } from "../lib/data-dir";
import { validateDirectEndpoint, type DirectEndpointConfig } from "../../shared/direct-endpoints";

const STORE_FILE = "direct-endpoints.json";
const SECRETS_FILE = "direct-endpoint-secrets.json";

let configuredRoot: string | undefined;

/** The server hands over its canonical writable root before provider bootstrap. */
export function configureDirectEndpointRoot(root: string): void { configuredRoot = root; }

function stateRoot(): string { return configuredRoot ?? resolveStateDir(process.cwd()); }

function secretsDirectory(root: string): string { return join(root, ".topics-secrets"); }

function writeAtomic(file: string, body: string, mode: number): void {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(temp, body, { mode, flag: "wx" });
    renameSync(temp, file);
  } finally {
    try { unlinkSync(temp); } catch { /* renamed, or never created */ }
  }
}

/**
 * Every endpoint the file declares, in file order.
 *
 * Entries that no longer validate are dropped one by one: a single bad line,
 * hand-edited or written by an older shape, must not cost the others.
 */
export function listDirectEndpoints(root = stateRoot()): DirectEndpointConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(root, STORE_FILE), "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: DirectEndpointConfig[] = [];
  for (const entry of parsed) {
    const result = validateDirectEndpoint(entry);
    if (result.ok && !out.some((seen) => seen.id === result.value.id)) out.push(result.value);
  }
  return out;
}

export function getDirectEndpoint(id: string, root = stateRoot()): DirectEndpointConfig | undefined {
  return listDirectEndpoints(root).find((entry) => entry.id === id);
}

function writeAll(endpoints: DirectEndpointConfig[], root: string): void {
  mkdirSync(root, { recursive: true });
  writeAtomic(join(root, STORE_FILE), JSON.stringify(endpoints, null, 2), 0o600);
}

/** Insert or replace by id, keeping the position of an endpoint already there. */
export function saveDirectEndpoint(endpoint: DirectEndpointConfig, root = stateRoot()): DirectEndpointConfig[] {
  const endpoints = listDirectEndpoints(root);
  const index = endpoints.findIndex((entry) => entry.id === endpoint.id);
  if (index >= 0) endpoints[index] = endpoint;
  else endpoints.push(endpoint);
  writeAll(endpoints, root);
  return endpoints;
}

/** Forget an endpoint and, with it, its token. */
export function deleteDirectEndpoint(id: string, root = stateRoot()): DirectEndpointConfig[] {
  const endpoints = listDirectEndpoints(root).filter((entry) => entry.id !== id);
  writeAll(endpoints, root);
  deleteEndpointSecret(id, root);
  return endpoints;
}

function readSecrets(root: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(secretsDirectory(root), SECRETS_FILE), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [id, token] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof token === "string" && token.trim()) out[id] = token;
    }
    return out;
  } catch {
    return {};
  }
}

function writeSecrets(secrets: Record<string, string>, root: string): void {
  const dir = secretsDirectory(root);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeAtomic(join(dir, SECRETS_FILE), JSON.stringify(secrets), 0o600);
}

export function readEndpointSecret(id: string, root = stateRoot()): string | undefined {
  return readSecrets(root)[id];
}

export function writeEndpointSecret(id: string, token: string, root = stateRoot()): void {
  writeSecrets({ ...readSecrets(root), [id]: token }, root);
}

export function deleteEndpointSecret(id: string, root = stateRoot()): void {
  const secrets = readSecrets(root);
  if (!(id in secrets)) return;
  delete secrets[id];
  writeSecrets(secrets, root);
}
