/**
 * Model proxy for paired nodes: lets a node's Claude CLI send its model calls
 * through THIS Topics, with no Claude login on the node.
 *
 * The node's CLI is configured with `ANTHROPIC_BASE_URL=http://127.0.0.1:<port
 * of a reverse ssh tunnel>` and `ANTHROPIC_AUTH_TOKEN=<node model token>`
 * (Claude Code's documented LLM-gateway mechanism). It then sends
 * `Authorization: Bearer <token>` to `<base>/v1/messages?beta=true` and
 * `<base>/v1/messages/count_tokens?beta=true`.
 *
 * SECURITY SHAPE. The reverse tunnel lands on loopback, and on the MAIN port a
 * loopback request is the owner (`server/lib/tunnel.ts`). So the proxy never
 * lives on the main server: it has a DEDICATED listener, bound to 127.0.0.1,
 * that serves exactly two POST paths and answers 404 to everything else. The
 * tunnel must target this port, never the main one. The listener exists only
 * when `TOPICS_MODEL_PROXY_PORT` is set.
 *
 * TOKENS. One per paired machine, minted by an owner-only route and shown once.
 * Only its SHA-256 is stored, at `<stateDir>/nodes/<machineId>.model-token.sha256`
 * (0600), next to the node's own token file: no DB migration. The comparison is
 * constant time.
 *
 * FORWARDING. The body is forwarded byte for byte to the same address the
 * native engine uses (`anthropicMessagesUrl`, so the account switcher on
 * `ANTHROPIC_BASE_URL` is honoured), with the Mac's own OAuth token instead of
 * the node's. The response is streamed back unchanged, SSE included.
 *
 * @covers MACHINE-02
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { anthropicMessagesUrl } from "../providers/native/base-url";
import { betaHeader } from "../providers/native/long-window";

const MACHINE_ID_SHAPE = /^[A-Za-z0-9_-]{1,128}$/;
const HASH_SUFFIX = ".model-token.sha256";
/** Largest request body accepted; a Messages call with images is the heavy case. */
export const MODEL_PROXY_MAX_BODY_BYTES = 32 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Token store
// ---------------------------------------------------------------------------

/** `<stateDir>/nodes/<machineId>.model-token.sha256`; an id that is not a plain name is refused. */
export function modelTokenPath(stateDir: string, machineId: string): string {
  if (!MACHINE_ID_SHAPE.test(machineId)) throw new Error(`modelTokenPath: machine id "${machineId}" is not a file name`);
  return join(stateDir, "nodes", `${machineId}${HASH_SUFFIX}`);
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Mints a fresh model token for a machine and stores only its hash. Returns the
 * plaintext, which is never stored: minting again replaces (revokes) the old one.
 */
export function mintModelToken(stateDir: string, machineId: string): string {
  const file = modelTokenPath(stateDir, machineId);
  const dir = join(stateDir, "nodes");
  const token = `tmt_${randomBytes(32).toString("base64url")}`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(file, `${sha256(token).toString("hex")}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return token;
}

/** Deletes the machine's model token. `true` when there was one. */
export function revokeModelToken(stateDir: string, machineId: string): boolean {
  const file = modelTokenPath(stateDir, machineId);
  if (!existsSync(file)) return false;
  unlinkSync(file);
  return true;
}

/**
 * The machine a presented token belongs to, or `null`. Every stored hash is
 * compared (no early exit on the first match), each in constant time.
 */
export function machineForModelToken(stateDir: string, presented: string): string | null {
  let names: string[];
  try {
    names = readdirSync(join(stateDir, "nodes"));
  } catch {
    return null;
  }
  const probe = sha256(presented);
  let found: string | null = null;
  for (const name of names) {
    if (!name.endsWith(HASH_SUFFIX)) continue;
    const machineId = name.slice(0, -HASH_SUFFIX.length);
    if (!MACHINE_ID_SHAPE.test(machineId)) continue;
    let stored: Buffer;
    try {
      stored = Buffer.from(readFileSync(join(stateDir, "nodes", name), "utf8").trim(), "hex");
    } catch {
      continue;
    }
    if (stored.length === probe.length && timingSafeEqual(stored, probe)) found = machineId;
  }
  return found;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export interface ModelProxyDeps {
  stateDir: string;
  /** A token only counts while its machine still has a row. */
  machineExists: (machineId: string) => boolean;
  getAccessToken: () => Promise<string | null>;
  recoverAfter401: (staleToken: string) => Promise<string | null>;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  maxBodyBytes?: number;
}

type ErrorType =
  | "invalid_request_error" | "authentication_error" | "not_found_error" | "request_too_large" | "api_error";

function apiError(status: number, type: ErrorType, message: string): Response {
  return new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection",
  "te", "trailer", "transfer-encoding", "upgrade",
]);
/** Request headers that never reach the upstream: the node's credentials and the framing the fetch redoes. */
const DROPPED_REQUEST = new Set(["authorization", "x-api-key", "cookie", "host", "content-length", "accept-encoding"]);
/** The fetch decodes the upstream body, so these would lie about what is sent back. */
const DROPPED_RESPONSE = new Set(["content-length", "content-encoding"]);

function presentedToken(req: Request): string | null {
  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("authorization") ?? "");
  return bearer?.[1] ?? req.headers.get("x-api-key")?.trim() ?? null;
}

/** The CLI's own headers minus its credentials, with the OAuth beta guaranteed. */
function upstreamHeaders(req: Request, accessToken: string): Headers {
  const out = new Headers();
  for (const [name, value] of req.headers) {
    const key = name.toLowerCase();
    if (DROPPED_REQUEST.has(key) || HOP_BY_HOP.has(key)) continue;
    out.set(key, value);
  }
  const beta = (out.get("anthropic-beta") ?? "").split(",").map((b) => b.trim()).filter(Boolean);
  for (const needed of betaHeader(false).split(",")) if (!beta.includes(needed)) beta.push(needed);
  out.set("anthropic-beta", beta.join(","));
  out.set("authorization", `Bearer ${accessToken}`);
  return out;
}

/** The body as bytes, or `null` when it exceeds the cap (stops reading at the cap). */
async function readCapped(req: Request, cap: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) return null;
  if (!req.body) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = req.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }
  return body;
}

/** The two paths served, mapped to the upstream URL they are forwarded to. */
function upstreamUrlFor(pathname: string, search: string): string | null {
  if (pathname === "/v1/messages") return anthropicMessagesUrl() + search;
  if (pathname === "/v1/messages/count_tokens") return `${anthropicMessagesUrl()}/count_tokens${search}`;
  return null;
}

export function createModelProxyHandler(deps: ModelProxyDeps): (req: Request) => Promise<Response> {
  const doFetch = deps.fetch ?? fetch;
  const cap = deps.maxBodyBytes ?? MODEL_PROXY_MAX_BODY_BYTES;
  const log = deps.log ?? ((line: string) => console.log(line));

  return async function modelProxy(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const target = req.method === "POST" ? upstreamUrlFor(url.pathname, url.search) : null;
    if (!target) return apiError(404, "not_found_error", "Not found");

    const token = presentedToken(req);
    const machineId = token ? machineForModelToken(deps.stateDir, token) : null;
    if (!machineId || !deps.machineExists(machineId)) {
      return apiError(401, "authentication_error", "Invalid or missing model token");
    }

    const started = Date.now();
    const body = await readCapped(req, cap);
    if (!body) return apiError(413, "request_too_large", `Request body exceeds ${cap} bytes`);

    let model: unknown;
    try {
      model = (JSON.parse(new TextDecoder().decode(body)) as { model?: unknown } | null)?.model;
    } catch {
      return apiError(400, "invalid_request_error", "Body must be JSON");
    }
    if (typeof model !== "string" || !model.startsWith("claude-")) {
      return apiError(400, "invalid_request_error", "Only claude-* models are served here");
    }

    let accessToken = await deps.getAccessToken();
    if (!accessToken) return apiError(503, "api_error", "No Claude login on the coordinator");

    const send = (bearer: string) =>
      doFetch(target, { method: "POST", headers: upstreamHeaders(req, bearer), body, signal: req.signal });
    const done = (status: number) => log(`[ModelProxy] machine=${machineId} model=${model} status=${status} ms=${Date.now() - started}`);

    try {
      let upstream = await send(accessToken);
      if (upstream.status === 401) {
        const renewed = await deps.recoverAfter401(accessToken);
        if (renewed) {
          await upstream.body?.cancel();
          accessToken = renewed;
          upstream = await send(accessToken);
        }
      }
      done(upstream.status);
      const headers = new Headers();
      for (const [name, value] of upstream.headers) {
        const key = name.toLowerCase();
        if (!HOP_BY_HOP.has(key) && !DROPPED_RESPONSE.has(key)) headers.set(key, value);
      }
      return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
    } catch (err) {
      done(502);
      return apiError(502, "api_error", `Upstream unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

// ---------------------------------------------------------------------------
// Dedicated listener
// ---------------------------------------------------------------------------

/** `TOPICS_MODEL_PROXY_PORT`, or `null` (listener off). */
export function modelProxyPort(env: Record<string, string | undefined>): number | null {
  const raw = env.TOPICS_MODEL_PROXY_PORT;
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

/** The only place the proxy is served: loopback, its own port, never the main server. */
export function createModelProxyListener(port: number, deps: ModelProxyDeps) {
  const handler = createModelProxyHandler(deps);
  return Bun.serve({
    port,
    hostname: "127.0.0.1",
    // A streamed answer may stay silent longer than the default 10 s idle timeout.
    idleTimeout: 255,
    fetch: (req) => handler(req),
  });
}
