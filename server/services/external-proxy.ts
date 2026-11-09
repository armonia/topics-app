/**
 * Proxy for Claude Code sessions opened OUTSIDE Topics (the Claude desktop app).
 *
 * WHY. Those sessions talk straight to api.anthropic.com: the app rewrites
 * `ANTHROPIC_BASE_URL` for its children, so the account engine (the switcher on
 * 127.0.0.1:3336 that picks the account and applies the usage caps) never sees
 * them. The bundled binary does honour `HTTPS_PROXY` and `NODE_EXTRA_CA_CERTS`,
 * so the app is relaunched with those two and its traffic lands here, INSIDE the
 * Topics server, instead of in a separate process.
 *
 * WHAT IT DOES. A dedicated listener on 127.0.0.1 (like `model-proxy.ts`: never
 * the main port, and it exists only when `TOPICS_EXTERNAL_PROXY_PORT` is set).
 *
 *   CONNECT other-host:port       -> byte tunnel, never opened
 *   CONNECT api.anthropic.com:443 -> byte tunnel into an INTERNAL loopback TLS
 *                                    server that terminates it with the local CA
 *                                    (`external-proxy-ca.ts`), then per request:
 *       POST /v1/messages[...]    -> `anthropicMessagesUrl()` (the engine of
 *                                    accounts, same address the native engine uses)
 *       anything else             -> https://api.anthropic.com as it is (OAuth,
 *                                    profile, telemetry), headers untouched
 *
 * The inner TLS endpoint is a native Bun listener, deliberately. The node:http server of Bun
 * is not built over sockets, so a decrypted stream cannot be handed to it. The native one
 * already provides HTTP parsing, TLS and streamed responses (SSE).
 *
 * FAIL-OPEN. When the engine is down the app must keep working, without caps:
 * the request goes to Anthropic with the original headers (the app's own token).
 * The engine counts as down when
 *   - the connection is refused or closed before any response, or
 *   - it gives no response headers within `silenceMs` AND its /health is also
 *     silent for another `healthMs`.
 * A slow answer is NOT a failure: the engine may hold a request for hours (usage
 * cap waiting), and sending it on to Anthropic would run it twice. That is why
 * the silence is checked against /health, which the engine serves out of queue.
 * The margin is measured: its event loop stalls 2-4 s, so a 2 s /health probe
 * would have bypassed the caps with the engine alive.
 * When the configured address IS Anthropic (no engine on this machine) there is
 * nothing to fail over from: the request is simply passed through.
 *
 * LOGS. Event, method, path WITHOUT query and with UUIDs masked, status, ms.
 * Never bodies, headers or tokens.
 */
import net from "node:net";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { anthropicMessagesUrl } from "../providers/native/base-url";
import { externalProxyCaDir, ensureExternalProxyLeaf, INTERCEPTED_HOST } from "./external-proxy-ca";
import { HOP_BY_HOP } from "./model-proxy";

export const EXTERNAL_PROXY_HOST = "127.0.0.1";
/** Largest request body accepted (a Messages call with images is the heavy case). */
export const EXTERNAL_PROXY_MAX_BODY_BYTES = 50 * 1024 * 1024;
/** No response headers from the engine for this long: ask its /health. */
export const EXTERNAL_PROXY_SILENCE_MS = 2000;
/** /health silent for this long: the engine is really down. */
export const EXTERNAL_PROXY_HEALTH_MS = 5000;

/** POST /v1/messages, /v1/messages?beta=true, /v1/messages/count_tokens: the calls that spend quota. */
const MESSAGES_PATH_RE = /^\/v1\/messages(?:\/count_tokens)?$/;
const MESSAGES_PREFIX = "/v1/messages";
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HEAD_LIMIT_BYTES = 16 * 1024;
const HEAD_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 15_000;

/** `TOPICS_EXTERNAL_PROXY_PORT`, or `null` (listener off). */
export function externalProxyPort(env: Record<string, string | undefined>): number | null {
  const raw = env.TOPICS_EXTERNAL_PROXY_PORT;
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

export interface ExternalProxyStats {
  connect: number;
  tunnel: number;
  intercepted: number;
  viaEngine: number;
  failOpen: number;
  direct: number;
}

export interface ExternalProxyOptions {
  /** 0 = ephemeral (tests). */
  port: number;
  host?: string;
  /** The leaf for api.anthropic.com. Without it the proxy only tunnels (the app keeps working, without caps). */
  tls?: { key: Buffer | string; cert: Buffer | string } | null;
  /** Where the Messages calls go; read at every request, so a changed engine address is followed. */
  messagesUrl?: () => string;
  /** Where everything else, and the fail-open, goes. Tests point it at a plain-HTTP fake. */
  upstreamBase?: string;
  silenceMs?: number;
  healthMs?: number;
  maxBodyBytes?: number;
  fetch?: typeof fetch;
  log?: (event: string, fields?: Record<string, string | number>) => void;
}

/** The path without query and without UUIDs (organizations, sessions): nothing else may reach a log. */
function bareUrl(urlPath: string): string {
  return urlPath.replace(UUID_RE, ":id").slice(0, 120);
}

function parseAuthority(authority: string): { host: string; port: number } | null {
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(authority) ?? /^([^:]+):(\d+)$/.exec(authority);
  if (!m) return null;
  const port = Number(m[2]);
  return port >= 1 && port <= 65535 ? { host: m[1]!.toLowerCase(), port } : null;
}

function cleanRequestHeaders(headers: Headers): Headers {
  const out = new Headers();
  for (const [name, value] of headers) {
    const key = name.toLowerCase();
    // host/length/encoding: the fetch redoes them; expect: the 100-continue was already answered to the client.
    if (HOP_BY_HOP.has(key) || key === "host" || key === "content-length" || key === "accept-encoding" || key === "expect") continue;
    out.set(key, value);
  }
  return out;
}

function cleanResponseHeaders(headers: Headers): Headers {
  const out = new Headers();
  for (const [name, value] of headers) {
    const key = name.toLowerCase();
    // the fetch decodes the body, so these two would lie about what is sent back
    if (HOP_BY_HOP.has(key) || key === "content-length" || key === "content-encoding") continue;
    out.set(key, value);
  }
  return out;
}

function proxyError(status: number, message: string): Response {
  return new Response(JSON.stringify({ type: "error", error: { type: "proxy_error", message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

class FailOver extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

export interface ExternalProxy {
  /** Port the CONNECT listener is on (the real one when `port` was 0). */
  port: number;
  stats: ExternalProxyStats;
  intercepting: boolean;
  close(): Promise<void>;
}

export async function startExternalProxy(options: ExternalProxyOptions): Promise<ExternalProxy> {
  const host = options.host ?? EXTERNAL_PROXY_HOST;
  const silenceMs = options.silenceMs ?? EXTERNAL_PROXY_SILENCE_MS;
  const healthMs = options.healthMs ?? EXTERNAL_PROXY_HEALTH_MS;
  const maxBodyBytes = options.maxBodyBytes ?? EXTERNAL_PROXY_MAX_BODY_BYTES;
  const messagesUrl = options.messagesUrl ?? anthropicMessagesUrl;
  const upstreamBase = (options.upstreamBase ?? `https://${INTERCEPTED_HOST}`).replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  const log = options.log ?? (() => {});
  const stats: ExternalProxyStats = { connect: 0, tunnel: 0, intercepted: 0, viaEngine: 0, failOpen: 0, direct: 0 };
  const sockets = new Set<net.Socket>();
  const track = (s: net.Socket) => {
    sockets.add(s);
    s.once("close", () => sockets.delete(s));
  };

  // -- requests inside the terminated TLS ---------------------------------------------------------------------

  /** Straight to Anthropic. With `body` the send is redone from the buffer; without, the request stream is piped. */
  async function toUpstream(req: Request, pathAndQuery: string, body: Uint8Array<ArrayBuffer> | undefined, why: string): Promise<Response> {
    const started = Date.now();
    const urlPath = new URL(pathAndQuery, "http://x").pathname;
    try {
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      // `duplex` is required by the spec when the body is a stream, but missing from the typings.
      const init: RequestInit & { duplex?: "half" } = {
        method: req.method,
        headers: cleanRequestHeaders(req.headers),
        body: hasBody ? (body ?? req.body ?? undefined) : undefined,
        signal: req.signal,
        redirect: "manual",
        duplex: "half",
      };
      const res = await doFetch(upstreamBase + pathAndQuery, init);
      stats.direct++;
      log(why, { method: req.method, path: bareUrl(urlPath), status: res.status, ms: Date.now() - started });
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: cleanResponseHeaders(res.headers) });
    } catch (e) {
      if (req.signal.aborted) return new Response(null, { status: 499 }); // the client left: not a fault to note
      log(`${why}-error`, { method: req.method, path: bareUrl(urlPath), code: errorCode(e) });
      return proxyError(502, `${INTERCEPTED_HOST} unreachable from the Topics proxy`);
    }
  }

  async function engineAlive(engineBase: string): Promise<boolean> {
    try {
      const res = await doFetch(`${engineBase}/health`, { signal: AbortSignal.timeout(healthMs) });
      await res.body?.cancel();
      return res.status >= 200 && res.status < 500;
    } catch {
      return false;
    }
  }

  /** One attempt at the engine. Resolves when it answers; rejects with FailOver when it is a fault, not a slow answer. */
  async function tryEngine(req: Request, target: string, body: Uint8Array<ArrayBuffer>): Promise<Response> {
    const abort = new AbortController();
    const signal = AbortSignal.any([req.signal, abort.signal]);
    let answered = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = doFetch(target, { method: "POST", headers: cleanRequestHeaders(req.headers), body, signal, redirect: "manual" });
    attempt.catch(() => {}); // when the watchdog wins, this one rejects on the abort: already handled
    // connected but mute: after silenceMs the engine's /health decides
    const watchdog = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        void engineAlive(new URL(target).origin).then((alive) => {
          if (alive || answered || req.signal.aborted) return;
          abort.abort();
          reject(new FailOver("no-response-health-down"));
        });
      }, silenceMs);
    });
    watchdog.catch(() => {});
    try {
      const res = await Promise.race([attempt, watchdog]);
      answered = true;
      return res;
    } catch (e) {
      if (e instanceof FailOver) throw e;
      if (req.signal.aborted) throw e;
      throw new FailOver(errorCode(e));
    } finally {
      clearTimeout(timer);
    }
  }

  async function forwardMessages(req: Request, url: URL): Promise<Response> {
    const started = Date.now();
    const target = `${messagesUrl()}${url.pathname.slice(MESSAGES_PREFIX.length)}${url.search}`;
    const body = new Uint8Array(await req.arrayBuffer());
    // No engine on this machine (the address is Anthropic itself): nothing to fail over from.
    if (new URL(target).origin === new URL(upstreamBase).origin) return toUpstream(req, url.pathname + url.search, body, "passthrough");
    try {
      const res = await tryEngine(req, target, body);
      stats.viaEngine++;
      log("engine", { method: req.method, path: bareUrl(url.pathname), status: res.status, ms: Date.now() - started });
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: cleanResponseHeaders(res.headers) });
    } catch (e) {
      if (req.signal.aborted) return new Response(null, { status: 499 });
      stats.failOpen++;
      log("fail-open", { reason: e instanceof FailOver ? e.reason : errorCode(e), method: req.method, path: bareUrl(url.pathname) });
      return toUpstream(req, url.pathname + url.search, body, "fail-open-upstream");
    }
  }

  // The internal TLS server. Only the front listener reaches it (random loopback port).
  const innerServer = options.tls?.key && options.tls?.cert
    ? Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        tls: { key: options.tls.key, cert: options.tls.cert },
        maxRequestBodySize: maxBodyBytes,
        idleTimeout: 255,
        async fetch(req, server) {
          const url = new URL(req.url);
          if (req.method === "POST" && MESSAGES_PATH_RE.test(url.pathname)) {
            // The engine may hold a request for hours (usage cap waiting): no idle cut.
            server.timeout(req, 0);
            try {
              return await forwardMessages(req, url);
            } catch (e) {
              log("proxy-error", { code: errorCode(e) });
              return proxyError(502, "internal proxy error");
            }
          }
          return toUpstream(req, url.pathname + url.search, undefined, "passthrough");
        },
      })
    : null;

  // -- the front listener: CONNECT + /health ------------------------------------------------------------------

  function onClient(client: net.Socket): void {
    track(client);
    client.on("error", () => {}); // a reset by the client: nothing to do, the close cleans up
    client.setTimeout(HEAD_TIMEOUT_MS, () => client.destroy());
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf("\r\n\r\n");
      if (end === -1) {
        if (buffered.length > HEAD_LIMIT_BYTES) client.destroy();
        return;
      }
      client.off("data", onData);
      client.setTimeout(0);
      const lines = buffered.subarray(0, end).toString("latin1").split("\r\n");
      const rest = buffered.subarray(end + 4);
      const [method, target] = (lines[0] ?? "").split(" ");
      if (method === "GET" && target === "/health") {
        client.end(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n${JSON.stringify({ status: "ok", intercepting: !!innerServer, ...stats })}`);
      } else if (method === "CONNECT") {
        onConnect(client, target ?? "", rest);
      } else {
        client.end("HTTP/1.1 501 Not Implemented\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\nexternal-proxy: CONNECT only\n");
      }
    };
    client.on("data", onData);
  }

  function onConnect(client: net.Socket, authority: string, rest: Buffer): void {
    stats.connect++;
    const parsed = parseAuthority(authority);
    if (!parsed) {
      client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    const intercept = !!innerServer && parsed.host === INTERCEPTED_HOST && parsed.port === 443;
    if (intercept) stats.intercepted++;
    else stats.tunnel++;
    // Both cases are a byte tunnel; they differ only in where it ends.
    const upstream = net.connect(intercept ? { host: "127.0.0.1", port: innerServer!.port! } : { host: parsed.host, port: parsed.port });
    track(upstream);
    upstream.setNoDelay(true);
    client.setNoDelay(true);
    upstream.setTimeout(CONNECT_TIMEOUT_MS, () => {
      if (upstream.connecting) upstream.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }));
    });
    let established = false;
    upstream.once("connect", () => {
      established = true;
      upstream.setTimeout(0);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (rest.length) upstream.write(rest);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", (e) => {
      if (!intercept) log("tunnel-error", { host: parsed.host, port: parsed.port, code: errorCode(e) });
      if (!established && !client.destroyed) client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      client.destroy();
    });
    upstream.on("close", () => client.destroy());
    client.on("close", () => upstream.destroy());
  }

  const front = net.createServer(onClient);
  await new Promise<void>((resolve, reject) => {
    front.once("error", reject);
    front.listen(options.port, host, () => {
      front.off("error", reject);
      resolve();
    });
  }).catch((e) => {
    innerServer?.stop(true);
    throw e;
  });
  const address = front.address() as net.AddressInfo;

  return {
    port: address.port,
    stats,
    intercepting: !!innerServer,
    close() {
      return new Promise<void>((resolve) => {
        front.close(() => resolve());
        void innerServer?.stop(true);
        // long connections (SSE, tunnels) are not worth waiting for
        setTimeout(() => {
          for (const s of sockets) s.destroy();
        }, 3000).unref();
        if (sockets.size === 0) resolve();
      });
    },
  };
}

function errorCode(e: unknown): string {
  const err = e as { code?: string; message?: string };
  return String(err?.code ?? err?.message ?? e).replace(/\s+/g, "_").slice(0, 60);
}

// ---------------------------------------------------------------------------
// Boot wiring + the state file other tools read
// ---------------------------------------------------------------------------

/**
 * What `claude-account` (and anything else that relaunches an external app) reads instead of
 * hard-coding it: `<topics home>/external-proxy.json`, next to `daemon-state.json`.
 */
export interface ExternalProxyState {
  host: string;
  port: number;
  /** Absolute path of the public CA certificate for `NODE_EXTRA_CA_CERTS`; null when the proxy only tunnels. */
  caCertificatePath: string | null;
  intercepting: boolean;
  pid: number;
  startedAt: string;
}

export function externalProxyStatePath(homeDir: string): string {
  return join(homeDir, "external-proxy.json");
}

function writeState(homeDir: string, state: ExternalProxyState): void {
  const file = externalProxyStatePath(homeDir);
  mkdirSync(homeDir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o644 });
  renameSync(tmp, file);
}

export interface BootedExternalProxy extends ExternalProxy {
  state: ExternalProxyState;
}

/**
 * Starts the proxy for the server: CA in `homeDir` (the Topics home, `~/.topics`),
 * listener on `port`,
 * state file written. A CA that cannot be built does not stop it (it tunnels only,
 * the app keeps its network). A port still held by the previous server process
 * (reload overlap) is retried for a few seconds, and the state file is written only
 * once the proxy is really listening.
 */
export async function bootExternalProxy(opts: {
  homeDir: string;
  port: number;
  log?: ExternalProxyOptions["log"];
  bindRetries?: number;
  bindRetryMs?: number;
}): Promise<BootedExternalProxy> {
  const log = opts.log ?? (() => {});
  let leafPair: ExternalProxyOptions["tls"] = null;
  let caCertificatePath: string | null = null;
  try {
    const leaf = ensureExternalProxyLeaf(externalProxyCaDir(opts.homeDir));
    leafPair = { key: leaf.key, cert: leaf.cert };
    caCertificatePath = leaf.caCertificatePath;
  } catch (e) {
    log("ca-failed-tunnel-only", { reason: errorCode(e) });
  }
  const retries = opts.bindRetries ?? 20;
  const wait = opts.bindRetryMs ?? 500;
  let proxy: ExternalProxy | null = null;
  for (let attempt = 0; !proxy; attempt++) {
    try {
      proxy = await startExternalProxy({ port: opts.port, tls: leafPair, log });
    } catch (e) {
      if ((e as { code?: string }).code !== "EADDRINUSE" || attempt >= retries) throw e;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  const state: ExternalProxyState = {
    host: EXTERNAL_PROXY_HOST,
    port: proxy.port,
    caCertificatePath,
    intercepting: proxy.intercepting,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  writeState(opts.homeDir, state);
  const close = proxy.close.bind(proxy);
  return {
    ...proxy,
    state,
    async close() {
      rmSync(externalProxyStatePath(opts.homeDir), { force: true });
      await close();
    },
  };
}
