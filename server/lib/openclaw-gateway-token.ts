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
import { join } from "path";

/** How long the resolver may take: it reads a local Keychain, not a network. */
const RESOLVER_TIMEOUT_MS = 5000;

function defaultConfigPath(): string {
  return join(process.env.HOME || homedir(), ".openclaw", "openclaw.json");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * The resolver's environment. `passEnv` is the list OpenClaw hands it, so it is
 * honoured: the command runs as OpenClaw runs it, and does not receive the rest
 * of the server's environment (which holds `GATEWAY_TOKEN` too).
 */
function resolverEnv(passEnv: unknown): NodeJS.ProcessEnv {
  if (!Array.isArray(passEnv)) return withoutGatewayToken();
  const env: NodeJS.ProcessEnv = {};
  for (const key of passEnv) {
    if (typeof key === "string" && process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

/** Resolves an exec SecretRef. Anything that goes wrong is null. */
function resolveExecRef(config: Record<string, unknown>, ref: Record<string, unknown>): string | null {
  const { provider, id } = ref;
  if (typeof provider !== "string" || !provider || typeof id !== "string" || !id) return null;
  const providers = isRecord(config.secrets) ? config.secrets.providers : undefined;
  const p = isRecord(providers) ? providers[provider] : undefined;
  if (!isRecord(p) || p.source !== "exec" || typeof p.command !== "string" || !p.command) return null;
  const args = Array.isArray(p.args) && p.args.every((a) => typeof a === "string") ? (p.args as string[]) : [];
  const r = spawnSync(p.command, args, {
    input: JSON.stringify({ protocolVersion: 1, provider, ids: [id] }),
    encoding: "utf-8",
    timeout: RESOLVER_TIMEOUT_MS,
    env: resolverEnv(p.passEnv),
    // The resolver's stderr is dropped: it may carry Keychain details.
    stdio: ["pipe", "pipe", "ignore"],
  });
  if (r.error || r.status !== 0 || typeof r.stdout !== "string") return null;
  const out: unknown = JSON.parse(r.stdout);
  const values = isRecord(out) ? out.values : undefined;
  const value = isRecord(values) ? values[id] : undefined;
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

/**
 * A child process environment without the gateway token.
 *
 * The server keeps the token in `process.env.GATEWAY_TOKEN` (startup puts it
 * there), and the daemons that start terminals and `claude` sessions
 * (pty-bridge, ai-bridge) handed their whole environment to every child: an
 * `env` in a terminal or in an agent's Bash printed it. No child uses it: the
 * MCP bridge authenticates with the daemon token.
 */
export function withoutGatewayToken(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { GATEWAY_TOKEN: _token, ...rest } = env;
  return rest;
}
