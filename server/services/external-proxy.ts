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
 *   CONNECT other-host:port       -> byte tunnel, never opened. NOT toward this machine: loopback
 *                                    (the main port trusts it), private and link-local targets, the
 *                                    Tailscale range and `*.ts.net`, and every address of this machine's
 *                                    interfaces get a 403, checked on the literal address AND on what
 *                                    the name resolves to (the connection is made to that answer, so
 *                                    no rebinding window)
 *   GET http://host:port/path     -> plain-http request relayed once per connection (origin-form, Connection:
 *                                    close). Loopback is allowed here, private ranges are refused as above
 *   CONNECT api.anthropic.com:443 -> byte tunnel into an INTERNAL loopback TLS
 *                                    server that terminates it with the local CA
 *                                    (`external-proxy-ca.ts`), then per request:
 *       POST /v1/messages[...]    -> `anthropicMessagesUrl()` (the engine of
 *                                    accounts, same address the native engine uses)
 *       anything else             -> https://api.anthropic.com as it is (OAuth,
 *                                    profile, telemetry), headers untouched
 *       WebSocket upgrade         -> relayed message by message to wss://api.anthropic.com: the
 *                                    upstream handshake is made first, the client gets its 101 only
 *                                    if that one worked (otherwise a 502), headers and subprotocol
 *                                    are carried across, close codes too (an abnormal end stays one).
 *                                    A slow client cannot be paused: the relay holds the bytes up to a
 *                                    limit, then CLOSES with 1013, never skips one. Client -> Anthropic has
 *                                    NO byte limit, a known gap (see "WebSocket limits" below).
 *
 * The inner TLS endpoint is a native Bun listener, deliberately. The node:http server of Bun
 * is not built over sockets, so a decrypted stream cannot be handed to it. The native one
 * already provides HTTP parsing, TLS, streamed responses (SSE) and WebSocket upgrades. For the
 * same reason an upgrade cannot become a byte tunnel after the TLS is terminated: it is relayed
 * at the message level instead.
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
import dns from "node:dns";
import net from "node:net";
import os from "node:os";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Server, ServerWebSocket } from "bun";
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
const WS_OPEN_TIMEOUT_MS = 15_000;
/**
 * WebSocket limits. Bounded: relays open together (`WS_MAX_RELAYS`, the next gets a 503 before Anthropic
 * is asked), one message from the client (`WS_MAX_MESSAGE_BYTES`, above it a close 1009, never handed on),
 * and what a slow CLIENT makes the relay hold (`RELAY_BACKLOG_LIMIT_BYTES`: past it a close 1013, never a
 * skipped message). NOT bounded: client -> Anthropic in total. Bun's client WebSocket reports
 * `bufferedAmount` as always 0 (checked on 1.3.8) and has neither a drain event nor a pause, so the relay
 * cannot know what sits unsent, and the server socket cannot be paused either: a client that sends faster
 * than Anthropic reads makes the relay hold every message, each up to `WS_MAX_MESSAGE_BYTES`, with no
 * ceiling on how many. Acceptable only because of who can do it: a process on this machine (the listener
 * is loopback-only), through at most `WS_MAX_RELAYS` sessions. A real bound needs a drain signal.
 */
const RELAY_BACKLOG_LIMIT_BYTES = 64 * 1024 * 1024;
/** The largest single WebSocket message accepted from the client. */
const WS_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
/** Bun drops a message above its `maxPayloadLength` without a close frame: its limit sits above ours, so 1009 can be sent. */
const WS_FRAME_MARGIN_BYTES = 1024 * 1024;
/** WebSocket relays open at the same time; one more is refused with a 503. */
const WS_MAX_RELAYS = 16;

/**
 * Where a CONNECT may NOT lead: this machine and its local networks. The main port of
 * Topics trusts the loopback, so a tunnel opened by this process toward 127.0.0.1 would
 * carry whatever a caller wants straight into it; the private ranges are the same trap one
 * hop further, and so is the tailnet: Tailscale gives this very machine an address in
 * 100.64.0.0/10 (and in fd7a:115c:a1e0::/48), which loops back to its own listeners.
 * IPv4-mapped IPv6 forms (`::ffff:127.0.0.1`) are matched by the list itself.
 */
const LOCAL_TARGETS = new net.BlockList();
for (const [network, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16],
] as const) LOCAL_TARGETS.addSubnet(network, bits, "ipv4");
LOCAL_TARGETS.addAddress("::", "ipv6");
LOCAL_TARGETS.addAddress("::1", "ipv6");
LOCAL_TARGETS.addSubnet("fc00::", 7, "ipv6"); // unique local (Tailscale's fd7a:115c:a1e0::/48 is inside it)
LOCAL_TARGETS.addSubnet("fe80::", 10, "ipv6"); // link-local

/** Every address assigned to an interface of this machine, read at each use (a VPN comes and goes). */
function currentInterfaceAddresses(): string[] {
  try {
    return Object.values(os.networkInterfaces()).flatMap((list) => (list ?? []).map((a) => a.address));
  } catch {
    return []; // a restricted environment may refuse to list them: the ranges above still apply, and a throw here would take the process down
  }
}

type InterfaceAddresses = () => readonly string[];

/**
 * True for an IP literal that points at this machine or a private/link-local network: the ranges
 * above, plus whatever address an interface of this machine has right now (a public one on a
 * server, a VPN's own range), which no table can know in advance.
 */
export function isLocalOrPrivateAddress(address: string, interfaceAddresses: InterfaceAddresses = currentInterfaceAddresses): boolean {
  const bare = address.split("%")[0]!; // an IPv6 zone id (`fe80::1%en0`) is not part of the address
  const family = net.isIP(bare);
  if (family === 0) return false;
  const kind = family === 4 ? "ipv4" : "ipv6";
  if (LOCAL_TARGETS.check(bare, kind)) return true;
  const own = new net.BlockList(); // a list, so that `2001:db8::7` and `2001:0db8::0007` are the same address
  for (const mine of interfaceAddresses()) {
    const ownBare = mine.split("%")[0]!;
    const ownFamily = net.isIP(ownBare);
    if (ownFamily !== 0) own.addAddress(ownBare, ownFamily === 4 ? "ipv4" : "ipv6");
  }
  return own.check(bare, kind);
}

/**
 * Names that are this machine without a lookup: `localhost` (loopback by definition) and the
 * tailnet's MagicDNS domain `ts.net` (its own hostname is one of them, and resolves to the
 * Tailscale address). With or without the root dot.
 */
function isLocalName(host: string): boolean {
  const name = host.replace(/\.$/, "");
  return name === "localhost" || name.endsWith(".localhost") || name === "ts.net" || name.endsWith(".ts.net");
}

/** Loopback by definition or by literal: 127.0.0.0/8, ::1, `localhost`, `*.localhost`. */
function isLoopbackHost(host: string): boolean {
  const name = host.replace(/\.$/, "");
  if (name === "localhost" || name.endsWith(".localhost")) return true;
  const family = net.isIP(name);
  if (family === 0) return false;
  return family === 4 ? name.startsWith("127.") : name === "::1" || /^::ffff:127\./i.test(name);
}

/** `error.code` of a refused target, as the connect error reports it. */
const BLOCKED_TARGET = "ETOPICSBLOCKED";

/**
 * The lookup the tunnel connects through: it refuses a name when ANY of its addresses is local
 * or private, and the socket is then opened on the very answer that was checked. Checking the
 * name and letting the socket resolve it again would leave a window for a rebinding trick.
 */
export function guardedLookupFor(interfaceAddresses: InterfaceAddresses = currentInterfaceAddresses): net.LookupFunction {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error, []);
      if (addresses.some((a) => isLocalOrPrivateAddress(a.address, interfaceAddresses))) {
        return callback(Object.assign(new Error("target is local or private"), { code: BLOCKED_TARGET }), []);
      }
      if (options.all) return callback(null, addresses);
      const first = addresses[0]!;
      return callback(null, first.address, first.family);
    });
  };
}

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
  /** Absolute-form http:// requests relayed (loopback included). */
  plain: number;
  intercepted: number;
  viaEngine: number;
  failOpen: number;
  direct: number;
  /** WebSocket upgrades relayed to Anthropic. */
  websocket: number;
  /** CONNECTs refused because the target is this machine or a private network. */
  refused: number;
}

export interface ExternalProxyOptions {
  /** 0 = ephemeral (tests). */
  port: number;
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
  /**
   * Lets CONNECT reach loopback and private addresses. Off, always, in production: tests turn it on
   * because their fake servers live on 127.0.0.1.
   */
  allowLocalTargets?: boolean;
  /** The addresses of this machine's interfaces; read at every CONNECT. Tests inject one a table cannot know. */
  interfaceAddresses?: () => readonly string[];
  /** Per connection, what the relay may hold for a CLIENT that reads too slowly (Anthropic -> client); past it the connection is closed (1013). */
  relayBacklogLimitBytes?: number;
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
  const silenceMs = options.silenceMs ?? EXTERNAL_PROXY_SILENCE_MS;
  const healthMs = options.healthMs ?? EXTERNAL_PROXY_HEALTH_MS;
  const maxBodyBytes = options.maxBodyBytes ?? EXTERNAL_PROXY_MAX_BODY_BYTES;
  const messagesUrl = options.messagesUrl ?? anthropicMessagesUrl;
  const upstreamBase = (options.upstreamBase ?? `https://${INTERCEPTED_HOST}`).replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  const allowLocalTargets = options.allowLocalTargets ?? false;
  const interfaceAddresses = options.interfaceAddresses ?? currentInterfaceAddresses;
  const guardedLookup = guardedLookupFor(interfaceAddresses);
  const backlogLimit = options.relayBacklogLimitBytes ?? RELAY_BACKLOG_LIMIT_BYTES;
  const log = options.log ?? (() => {});
  const stats: ExternalProxyStats = { connect: 0, tunnel: 0, plain: 0, intercepted: 0, viaEngine: 0, failOpen: 0, direct: 0, websocket: 0, refused: 0 };
  const sockets = new Set<net.Socket>();
  /** WebSocket relays holding a place: from the admission to the close of the server socket. */
  let openRelays = 0;
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
      // manual: a redirect from /health is an answer, not an invitation to fetch whatever it points at
      const res = await doFetch(`${engineBase}/health`, { signal: AbortSignal.timeout(healthMs), redirect: "manual" });
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

  // -- WebSocket upgrades ----------------------------------------------------------------------------------

  /** One relayed connection: the upstream socket, what it said before the client side was open, and how it ended. */
  interface RelayData {
    upstream: WebSocket;
    backlog: Array<string | ArrayBuffer>;
    backlogBytes: number;
    ended: { code: number; reason: string } | null;
    client: ServerWebSocket<RelayData> | null;
    /** Set once the relay ended the connection by its own decision (a slow client, an oversized message): from then on nothing more is relayed. */
    overflowed: boolean;
    started: number;
    path: string;
  }

  /** Close codes a peer may put on the wire (1005/1006/1015 only DESCRIBE a connection that had no proper close, 1004 is reserved). */
  function isWireCloseCode(code: number): boolean {
    return (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) || (code >= 3000 && code <= 4999);
  }

  function messageBytes(message: string | ArrayBuffer | Uint8Array): number {
    return typeof message === "string" ? Buffer.byteLength(message) : message.byteLength;
  }

  /** The relay ends the connection by its own decision: the client is told `code`, Anthropic 1011, nothing more is relayed (a prefix, never a hole). */
  function giveUp(data: RelayData, code: number, reason: string, event: string): void {
    if (data.overflowed) return;
    data.overflowed = true;
    data.backlog.length = 0;
    data.backlogBytes = 0;
    log(event, { path: data.path, ms: Date.now() - data.started });
    try { data.client?.close(code, reason); } catch { /* already closed */ }
    try { data.upstream.close(1011, reason); } catch { /* already closed */ }
  }
  const overflow = (data: RelayData) => giveUp(data, 1013, "relay buffer full", "ws-backpressure");

  /** Anthropic -> client. */
  function deliverToClient(data: RelayData, message: string | ArrayBuffer): void {
    if (data.overflowed) return;
    const size = messageBytes(message);
    if (!data.client) {
      if (data.backlogBytes + size > backlogLimit) return overflow(data);
      data.backlogBytes += size;
      data.backlog.push(message);
      return;
    }
    if (data.client.getBufferedAmount() + size > backlogLimit) return overflow(data);
    if (data.client.send(message) === 0) overflow(data); // 0 = the socket dropped it: say so, do not leave a hole
  }

  /** What the client is told when Anthropic's side ended: the same code and reason, and an abnormal end stays abnormal (never a 1000). */
  function endClient(data: RelayData): void {
    if (!data.client || !data.ended || data.overflowed) return;
    const { code, reason } = data.ended;
    try {
      if (code === 1005) data.client.close(); // an empty close frame: there was no status to carry
      else if (isWireCloseCode(code)) data.client.close(code, reason);
      else data.client.close(1011, "upstream closed abnormally"); // 1006 (dropped), 1015 (TLS failure), anything unspeakable
    } catch { /* already closed */ }
  }

  /** The client's close, toward Anthropic. The code travels; the reason only where Bun's client socket keeps it (1000 and 3000-4999). */
  function endUpstream(data: RelayData, code: number, reason: string): void {
    if (data.upstream.readyState > WebSocket.OPEN) return;
    try {
      // The relay already gave up on this connection (`overflow`): what the client echoes back (1013) is not Anthropic's to hear,
      // and its socket may still be flooding us, so no polite handshake is waited for.
      if (data.overflowed) (data.upstream as WebSocket & { terminate(): void }).terminate();
      else if (code === 1005) data.upstream.close(); // an empty close frame
      else if (isWireCloseCode(code)) data.upstream.close(code, reason);
      else (data.upstream as WebSocket & { terminate(): void }).terminate(); // Bun's extension, missing from the DOM typings. 1006: the client vanished, Anthropic sees a drop too
    } catch { /* already closed */ }
  }

  /** The handshake with Anthropic. Resolves once it is open; from then on its messages are queued until the client side is. */
  function openRelay(url: string, protocols: string[], headers: Headers, signal: AbortSignal, path: string): Promise<RelayData> {
    return new Promise((resolve, reject) => {
      // `headers` is a Bun extension of the constructor options, missing from the DOM typings
      const upstream = new WebSocket(url, { protocols, headers: Object.fromEntries(headers) } as unknown as string[]);
      upstream.binaryType = "arraybuffer";
      const data: RelayData = { upstream, backlog: [], backlogBytes: 0, ended: null, client: null, overflowed: false, started: Date.now(), path };
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (!error) return resolve(data);
        try { upstream.close(); } catch { /* never opened */ }
        reject(error);
      };
      const onAbort = () => finish(new Error("client-left"));
      const timer = setTimeout(() => finish(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })), WS_OPEN_TIMEOUT_MS);
      signal.addEventListener("abort", onAbort, { once: true });
      upstream.onopen = () => finish();
      upstream.onerror = () => finish(new Error("handshake-failed"));
      upstream.onmessage = (event) => deliverToClient(data, event.data as string | ArrayBuffer);
      upstream.onclose = (event) => {
        if (!settled) return finish(new Error("closed-before-open"));
        data.ended = { code: event.code, reason: event.reason };
        endClient(data);
      };
    });
  }

  async function relayWebSocket(req: Request, server: Server<RelayData>): Promise<Response | undefined> {
    const url = new URL(req.url);
    const path = bareUrl(url.pathname);
    const protocols = (req.headers.get("sec-websocket-protocol") ?? "").split(",").map((p) => p.trim()).filter(Boolean);
    const headers = cleanRequestHeaders(req.headers); // the handshake of our own socket redoes upgrade/connection/host
    for (const key of [...headers.keys()]) if (key.startsWith("sec-websocket-")) headers.delete(key);
    // The place is taken before the handshake (a burst must not all get in) and given back on every way out.
    if (openRelays >= WS_MAX_RELAYS) {
      log("ws-refused", { path, open: openRelays });
      return proxyError(503, "too many WebSocket connections through the Topics proxy");
    }
    openRelays++;
    let data: RelayData;
    try {
      data = await openRelay(upstreamBase.replace(/^http/, "ws") + url.pathname + url.search, protocols, headers, req.signal, path);
    } catch (e) {
      openRelays--;
      if (req.signal.aborted) return new Response(null, { status: 499 });
      log("ws-error", { path, code: errorCode(e) });
      return proxyError(502, `${INTERCEPTED_HOST} unreachable from the Topics proxy`);
    }
    // The subprotocol is the one Anthropic chose, not the first one the client offered.
    const chosen = data.upstream.protocol;
    if (!server.upgrade(req, { data, headers: chosen ? { "sec-websocket-protocol": chosen } : undefined })) {
      openRelays--;
      data.upstream.close();
      return proxyError(400, "websocket upgrade refused");
    }
    stats.websocket++;
    log("ws", { path, status: 101, ms: Date.now() - data.started });
    return undefined;
  }

  // The internal TLS server. Only the front listener reaches it (random loopback port).
  const innerServer = options.tls?.key && options.tls?.cert
    ? Bun.serve<RelayData, never>({
        port: 0,
        hostname: "127.0.0.1",
        tls: { key: options.tls.key, cert: options.tls.cert },
        maxRequestBodySize: maxBodyBytes,
        idleTimeout: 255,
        // Bun counts what it holds per connection and, past its limit, drops silently: the relay's own limit
        // (`overflow`) must trip first, so Bun's sits above it by one largest message, and closes if ever reached.
        websocket: {
          backpressureLimit: backlogLimit + WS_MAX_MESSAGE_BYTES,
          closeOnBackpressureLimit: true,
          maxPayloadLength: WS_MAX_MESSAGE_BYTES + WS_FRAME_MARGIN_BYTES,
          open(ws) {
            ws.data.client = ws;
            const queued = ws.data.backlog.splice(0);
            ws.data.backlogBytes = 0;
            if (ws.data.overflowed) ws.close(1013, "relay buffer full"); // gave up while the client was still being upgraded
            for (const message of queued) deliverToClient(ws.data, message);
            endClient(ws.data);
          },
          message(ws, message) {
            const data = ws.data;
            if (data.overflowed || data.upstream.readyState !== WebSocket.OPEN) return; // the connection is already ending
            if (messageBytes(message) > WS_MAX_MESSAGE_BYTES) return giveUp(data, 1009, "message too big", "ws-too-big");
            // No byte count toward Anthropic: see "WebSocket limits". `upstream.bufferedAmount` is always 0 on Bun's client socket.
            data.upstream.send(message);
          },
          close(ws, code, reason) {
            openRelays--;
            ws.data.client = null;
            log("ws-closed", { path: ws.data.path, ms: Date.now() - ws.data.started });
            endUpstream(ws.data, code, reason);
          },
        },
        async fetch(req, server) {
          const url = new URL(req.url);
          if (req.headers.get("upgrade")?.toLowerCase() === "websocket") return relayWebSocket(req, server);
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
      } else if (/^http:\/\//i.test(target ?? "")) {
        onPlainHttp(client, method ?? "GET", target!, lines.slice(1), rest);
      } else {
        client.end("HTTP/1.1 501 Not Implemented\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\nexternal-proxy: only CONNECT and absolute http:// requests\n");
      }
    };
    client.on("data", onData);
  }

  /**
   * An absolute-form request (`GET http://host:port/path`), which is what a client sends through an HTTP proxy
   * for a plain-http URL (the MCP gateway on loopback is one). It is relayed as one request per connection:
   * the request line becomes origin-form, `Connection: close` is forced and the proxy headers are dropped.
   * Loopback is allowed HERE and only here (a plain-http target is never the intercepted host and the caller
   * is a process of this machine that could connect directly); private and tailnet ranges stay refused.
   */
  function onPlainHttp(client: net.Socket, method: string, target: string, headerLines: string[], rest: Buffer): void {
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    stats.plain++;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const port = url.port ? Number(url.port) : 80;
    const loopback = isLoopbackHost(host);
    if (!allowLocalTargets && !loopback && (isLocalName(host) || isLocalOrPrivateAddress(host, interfaceAddresses))) {
      stats.plain--;
      refuse(client, host, port);
      return;
    }
    const kept = headerLines.filter((line) => !/^(proxy-connection|proxy-authorization|connection):/i.test(line));
    const head = `${method} ${url.pathname}${url.search} HTTP/1.1\r\n${kept.join("\r\n")}${kept.length ? "\r\n" : ""}connection: close\r\n\r\n`;
    const upstream = net.connect({ host, port, ...(allowLocalTargets || loopback ? {} : { lookup: guardedLookup }) });
    track(upstream);
    upstream.setNoDelay(true);
    upstream.setTimeout(CONNECT_TIMEOUT_MS, () => {
      if (upstream.connecting) upstream.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }));
    });
    let established = false;
    upstream.once("connect", () => {
      established = true;
      upstream.setTimeout(0);
      upstream.write(head);
      if (rest.length) upstream.write(rest);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", (e) => {
      if ((e as NodeJS.ErrnoException).code === BLOCKED_TARGET) {
        stats.plain--;
        refuse(client, host, port);
      } else {
        log("plain-error", { host, port, code: errorCode(e) });
        if (!established && !client.destroyed) client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      }
      client.destroy();
    });
    upstream.on("close", () => client.destroy());
    client.on("close", () => upstream.destroy());
  }

  function refuse(client: net.Socket, host: string, port: number): void {
    stats.refused++;
    log("connect-refused", { host, port });
    client.end("HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\nexternal-proxy: this machine and private networks are not tunnelled\n");
  }

  function onConnect(client: net.Socket, authority: string, rest: Buffer): void {
    stats.connect++;
    const parsed = parseAuthority(authority);
    if (!parsed) {
      client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    const intercept = !!innerServer && parsed.host === INTERCEPTED_HOST && parsed.port === 443;
    // A literal address or a name that is loopback by definition is refused without a lookup; every other
    // name is checked on what it resolves to (guardedLookup), at the moment the socket connects.
    if (!intercept && !allowLocalTargets && (isLocalName(parsed.host) || isLocalOrPrivateAddress(parsed.host, interfaceAddresses))) {
      refuse(client, parsed.host, parsed.port);
      return;
    }
    if (intercept) stats.intercepted++;
    else stats.tunnel++;
    // Both cases are a byte tunnel; they differ only in where it ends.
    const upstream = net.connect(
      intercept
        ? { host: "127.0.0.1", port: innerServer!.port! }
        : { host: parsed.host, port: parsed.port, ...(allowLocalTargets ? {} : { lookup: guardedLookup }) },
    );
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
      if ((e as NodeJS.ErrnoException).code === BLOCKED_TARGET) {
        stats.tunnel--;
        refuse(client, parsed.host, parsed.port);
      } else {
        if (!intercept) log("tunnel-error", { host: parsed.host, port: parsed.port, code: errorCode(e) });
        if (!established && !client.destroyed) client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      }
      client.destroy();
    });
    upstream.on("close", () => client.destroy());
    client.on("close", () => upstream.destroy());
  }

  const front = net.createServer(onClient);
  await new Promise<void>((resolve, reject) => {
    front.once("error", reject);
    front.listen(options.port, EXTERNAL_PROXY_HOST, () => {
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
