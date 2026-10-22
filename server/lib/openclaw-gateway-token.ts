/**
 * THE OPENCLAW GATEWAY TOKEN, read from `~/.openclaw/openclaw.json`.
 *
 * `gateway.auth.token` comes in two shapes:
 *  - a plain string (the historical one);
 *  - a SecretRef `{ source: "exec", provider, id }`, which OpenClaw resolves by
 *    running the command of `secrets.providers[provider]` over the exec
 *    protocol: JSON on stdin `{ protocolVersion: 1, provider, ids: [id] }`,
 *    JSON on stdout `{ values: { [id]: value }, errors: {...} }`.
 *
 * Before this module Topics read the field as a string: with a SecretRef,
 * "[object Object]" landed in `GATEWAY_TOKEN`, and the API (which accepts
 * `x-gateway-token`) would have accepted exactly that string, the same on
 * every machine.
 *
 * The value is never printed: callers use it and nothing else.
 */
import { readFileSync } from "fs";
import { spawnSync } from "child_process";
import { homedir } from "os";
import { dirname, join } from "path";

/** How long the resolver may take: it reads a local Keychain, not a network. */
const RESOLVER_TIMEOUT_MS = 5000;

/** OpenClaw's own override first (`OPENCLAW_CONFIG_PATH`), as OpenClaw reads it. */
function defaultConfigPath(): string {
  return process.env.OPENCLAW_CONFIG_PATH || join(process.env.HOME || homedir(), ".openclaw", "openclaw.json");
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? join(process.env.HOME || homedir(), p.slice(1)) : p;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * The resolver runs as OpenClaw runs it: an EMPTY base environment plus the
 * `passEnv` names and the literal `env` map, the command's own directory as
 * cwd, `~` expanded. Anything else and a provider that works for OpenClaw
 * would fail here, or receive the server's whole environment.
 */
function resolverEnv(provider: Record<string, unknown>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of Array.isArray(provider.passEnv) ? provider.passEnv : []) {
    if (typeof key === "string" && process.env[key] !== undefined) env[key] = process.env[key];
  }
  if (isRecord(provider.env)) {
    for (const [key, value] of Object.entries(provider.env)) if (typeof value === "string") env[key] = value;
  }
  return env;
}

/**
 * The value for `id` in the resolver's stdout: the exec protocol's JSON
 * `{ protocolVersion: 1, values }`, or, when the provider sets
 * `jsonOnly: false`, the bare output itself.
 */
function parseResolverOutput(stdout: string, id: string, jsonOnly: boolean): unknown {
  const trimmed = stdout.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return jsonOnly ? undefined : trimmed;
  }
  if (!isRecord(parsed)) return !jsonOnly && typeof parsed === "string" ? parsed : undefined;
  if (parsed.protocolVersion !== 1 || !isRecord(parsed.values)) return undefined;
  return parsed.values[id];
}

/** Resolves an exec SecretRef. Anything that goes wrong is null. */
function resolveExecRef(config: Record<string, unknown>, ref: Record<string, unknown>): string | null {
  const { provider, id } = ref;
  if (typeof provider !== "string" || !provider || typeof id !== "string" || !id) return null;
  const providers = isRecord(config.secrets) ? config.secrets.providers : undefined;
  const p = isRecord(providers) ? providers[provider] : undefined;
  if (!isRecord(p) || p.source !== "exec" || typeof p.command !== "string" || !p.command) return null;
  const command = expandHome(p.command);
  const args = Array.isArray(p.args) && p.args.every((a) => typeof a === "string") ? (p.args as string[]) : [];
  const r = spawnSync(command, args, {
    input: JSON.stringify({ protocolVersion: 1, provider, ids: [id] }),
    encoding: "utf-8",
    timeout: RESOLVER_TIMEOUT_MS,
    cwd: dirname(command),
    env: resolverEnv(p),
    // The resolver's stderr is dropped: it may carry Keychain details.
    stdio: ["pipe", "pipe", "ignore"],
  });
  if (r.error || r.status !== 0 || typeof r.stdout !== "string") return null;
  const value = parseResolverOutput(r.stdout, id, p.jsonOnly !== false);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * The gateway token from `openclaw.json`: a string, or an exec SecretRef
 * resolved. Null when the file is missing or broken, the reference does not
 * resolve, or the value is not a non-empty string. Never throws.
 */
export function readOpenClawGatewayToken(configPath: string = defaultConfigPath()): string | null {
  try {
    const config: unknown = JSON.parse(readFileSync(configPath, "utf-8"));
    if (!isRecord(config)) return null;
    const gateway = config.gateway;
    const auth = isRecord(gateway) ? gateway.auth : undefined;
    const token = isRecord(auth) ? auth.token : undefined;
    if (typeof token === "string") return token.trim() || null;
    if (isRecord(token) && token.source === "exec") return resolveExecRef(config, token);
    return null;
  } catch {
    return null;
  }
}

let held: string | undefined;

/**
 * The gateway token the server uses, kept OUT of `process.env`.
 *
 * Every child the server starts with `...process.env` inherited it: check
 * scripts, previews, worktree setup, and the bottom of a red check's output
 * goes back to the agent that wrote the check. Startup moves the token here
 * with `holdGatewayToken`. Before that (and in tests that set it) the
 * environment is still read.
 */
export function gatewayToken(): string | undefined {
  return held ?? (process.env.GATEWAY_TOKEN || undefined);
}

/** Keeps `value` as the gateway token and takes it out of `process.env`. */
export function holdGatewayToken(value: string | null | undefined): void {
  held = value || undefined;
  delete process.env.GATEWAY_TOKEN;
}

/**
 * A child process environment without the gateway token.
 *
 * Belt and braces next to `holdGatewayToken`: the daemons that start
 * terminals and `claude` sessions (pty-bridge, ai-bridge) hand their whole
 * environment to every child, so they must never get it, even from a server
 * started with GATEWAY_TOKEN in its environment that has not moved it yet.
 */
export function withoutGatewayToken(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { GATEWAY_TOKEN: _token, ...rest } = env;
  return rest;
}
