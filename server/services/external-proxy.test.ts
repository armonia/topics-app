/**
 * The proxy for Claude Code sessions outside Topics: forwarding to the account
 * engine, byte tunnels, fail-open, streamed answers, CA permissions.
 *
 * Everything runs on ephemeral ports of 127.0.0.1 with a fake engine and a fake
 * api.anthropic.com (plain HTTP behind `upstreamBase`): no network, no real :3336.
 * The client is Bun's own `fetch` with `proxy` + `tls.ca`, which is what the
 * bundled Claude binary does with `HTTPS_PROXY` + `NODE_EXTRA_CA_CERTS`.
 *
 * Targets of CONNECT on this machine are refused by default; the tests whose fakes live on 127.0.0.1
 * switch that off (`allowLocalTargets`), and the ones about the refusal leave it on.
 *
 * @covers EXTPROXY-01
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import net from "node:net";
import tls from "node:tls";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureExternalProxyLeaf, type ExternalProxyLeaf } from "./external-proxy-ca";
import {
  bootExternalProxy, externalProxyPort, externalProxyStatePath, guardedLookup, isLocalOrPrivateAddress, startExternalProxy,
  type ExternalProxy, type ExternalProxyOptions,
} from "./external-proxy";

const CALLER_AUTH = "fake-oauth-credential-for-tests";
let dir: string;
let leaf: ExternalProxyLeaf;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "external-proxy-test-"));
  leaf = ensureExternalProxyLeaf(join(dir, "ca"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface Seen { method: string; url: string; headers: Headers; body: string }

/** A fake HTTP server that records every request and answers with `handler`. */
function fake(handler: (req: Request, seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const entry: Seen = { method: req.method, url: new URL(req.url).pathname + new URL(req.url).search, headers: req.headers, body: await req.text() };
      seen.push(entry);
      return handler(req, entry);
    },
  });
  return { port: server.port as number, seen, stop: () => server.stop(true) };
}

async function closedPort(): Promise<number> {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const p = s.port as number;
  s.stop(true);
  return p;
}

async function start(extra: Partial<ExternalProxyOptions> & { enginePort: number; upstreamPort?: number }) {
  const lines: string[] = [];
  const { enginePort, upstreamPort, ...rest } = extra;
  const proxy = await startExternalProxy({
    port: 0,
    tls: { key: leaf.key, cert: leaf.cert },
    messagesUrl: () => `http://127.0.0.1:${enginePort}/v1/messages`,
    upstreamBase: `http://127.0.0.1:${upstreamPort ?? 1}`,
    log: (event, fields) => lines.push(`${event} ${JSON.stringify(fields ?? {})}`),
    ...rest,
  });
  return { proxy, lines };
}

/** A request to api.anthropic.com THROUGH the proxy (CONNECT + TLS terminated with our CA). */
function viaProxy(proxy: ExternalProxy, path: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) {
  return fetch(`https://api.anthropic.com${path}`, {
    method: init.method ?? "POST",
    body: (init.method ?? "POST") === "GET" ? undefined : init.body ?? "",
    headers: { authorization: `Bearer ${CALLER_AUTH}`, "anthropic-beta": "oauth-2025-04-20", ...init.headers },
    proxy: `http://127.0.0.1:${proxy.port}`,
    tls: { ca: readFileSync(leaf.caCertificatePath, "utf8") },
  } as RequestInit);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("forwarding", () => {
  test("POST /v1/messages and count_tokens go to the engine, body and headers intact", async () => {
    const engine = fake(() => Response.json({ via: "engine" }));
    const upstream = fake(() => Response.json({ via: "anthropic" }));
    const { proxy, lines } = await start({ enginePort: engine.port, upstreamPort: upstream.port });
    try {
      const payload = JSON.stringify({ model: "claude-haiku-4-5", messages: [{ role: "user", content: "ciao è ☃" }] });
      const r = await viaProxy(proxy, "/v1/messages?beta=true", { body: payload, headers: { "content-type": "application/json" } });
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ via: "engine" });
      const r2 = await viaProxy(proxy, "/v1/messages/count_tokens", { body: payload });
      expect(await r2.json()).toEqual({ via: "engine" });

      expect(engine.seen).toHaveLength(2);
      expect(engine.seen[0]!.method).toBe("POST");
      expect(engine.seen[0]!.url).toBe("/v1/messages?beta=true");
      expect(engine.seen[0]!.body).toBe(payload);
      expect(engine.seen[0]!.headers.get("authorization")).toBe(`Bearer ${CALLER_AUTH}`);
      expect(engine.seen[0]!.headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
      expect(engine.seen[1]!.url).toBe("/v1/messages/count_tokens");
      expect(upstream.seen).toHaveLength(0);
      expect(lines.some((l) => l.startsWith("fail-open"))).toBe(false);
      expect(proxy.stats.viaEngine).toBe(2);
    } finally { await proxy.close(); engine.stop(); upstream.stop(); }
  });

  test("the other paths of api.anthropic.com (OAuth, profile) go to Anthropic, not to the engine", async () => {
    const engine = fake(() => new Response("engine"));
    const upstream = fake(() => new Response("anthropic", { status: 201, headers: { "x-up": "1" } }));
    const { proxy } = await start({ enginePort: engine.port, upstreamPort: upstream.port });
    try {
      const g = await viaProxy(proxy, "/api/oauth/profile", { method: "GET" });
      expect(g.status).toBe(201);
      expect(await g.text()).toBe("anthropic");
      expect(g.headers.get("x-up")).toBe("1");
      const o = await viaProxy(proxy, "/v1/oauth/token", { body: "grant_type=refresh_token" });
      expect(await o.text()).toBe("anthropic");
      // a GET on /v1/messages spends no quota: it is not a call to count
      const m = await viaProxy(proxy, "/v1/messages", { method: "GET" });
      expect(await m.text()).toBe("anthropic");

      expect(engine.seen).toHaveLength(0);
      expect(upstream.seen).toHaveLength(3);
      expect(upstream.seen[0]!.headers.get("authorization")).toBe(`Bearer ${CALLER_AUTH}`);
      expect(upstream.seen[1]!.body).toBe("grant_type=refresh_token");
    } finally { await proxy.close(); engine.stop(); upstream.stop(); }
  });

  test("with no engine on this machine (the address is Anthropic) Messages calls pass straight through", async () => {
    const upstream = fake(() => Response.json({ via: "anthropic" }));
    const { proxy, lines } = await start({
      enginePort: 1,
      upstreamPort: upstream.port,
      messagesUrl: () => `http://127.0.0.1:${upstream.port}/v1/messages`,
    });
    try {
      const r = await viaProxy(proxy, "/v1/messages", { body: "{}" });
      expect(await r.json()).toEqual({ via: "anthropic" });
      expect(upstream.seen).toHaveLength(1);
      expect(proxy.stats.failOpen).toBe(0);
      expect(lines.some((l) => l.startsWith("fail-open"))).toBe(false);
    } finally { await proxy.close(); upstream.stop(); }
  });

  test("a body above the cap is refused before it reaches the engine", async () => {
    const engine = fake(() => new Response("engine"));
    const { proxy } = await start({ enginePort: engine.port, maxBodyBytes: 1024 });
    try {
      const r = await viaProxy(proxy, "/v1/messages", { body: "x".repeat(4096) });
      expect(r.status).toBe(413);
      expect(engine.seen).toHaveLength(0);
    } finally { await proxy.close(); engine.stop(); }
  });
});

describe("tunnel", () => {
  test("another host is a byte tunnel: bytes arrive identical, no TLS is terminated", async () => {
    const echo = net.createServer((s) => s.on("data", (d: Buffer) => s.write(Buffer.concat([Buffer.from("echo:"), d]))));
    await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
    const echoPort = (echo.address() as net.AddressInfo).port;
    const { proxy } = await start({ enginePort: await closedPort(), allowLocalTargets: true });
    try {
      const socket = net.connect(proxy.port, "127.0.0.1");
      const head = await new Promise<string>((resolve) => {
        socket.once("data", (d) => resolve(d.toString()));
        socket.write(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nhost: 127.0.0.1:${echoPort}\r\n\r\n`);
      });
      expect(head.startsWith("HTTP/1.1 200")).toBe(true);
      const payload = Buffer.from([0x16, 0x03, 0x01, 0x00, 0xff, 0x00, 0x7f]); // looks like a ClientHello: it goes through, unread
      const got = await new Promise<Buffer>((resolve) => { socket.once("data", resolve); socket.write(payload); });
      expect(got).toEqual(Buffer.concat([Buffer.from("echo:"), payload]));
      socket.destroy();
      expect(proxy.stats.tunnel).toBe(1);
      expect(proxy.stats.intercepted).toBe(0);

      // a host that does not answer: 502 to the client, no crash
      const closed = await closedPort();
      const refused = net.connect(proxy.port, "127.0.0.1");
      const reply = await new Promise<string>((resolve) => {
        refused.once("data", (d) => resolve(d.toString()));
        refused.write(`CONNECT 127.0.0.1:${closed} HTTP/1.1\r\n\r\n`);
      });
      expect(reply.startsWith("HTTP/1.1 502")).toBe(true);
      refused.destroy();
    } finally { await proxy.close(); echo.close(); }
  });

  test("GET /health answers on the front port; anything else that is not CONNECT is refused", async () => {
    const { proxy } = await start({ enginePort: await closedPort() });
    try {
      const h = await fetch(`http://127.0.0.1:${proxy.port}/health`);
      expect(h.status).toBe(200);
      expect(await h.json()).toMatchObject({ status: "ok", intercepting: true });
      const other = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, { method: "POST", body: "{}" });
      expect(other.status).toBe(501);
    } finally { await proxy.close(); }
  });

  test("without a CA the proxy only tunnels: api.anthropic.com is not intercepted", async () => {
    const { proxy } = await start({ enginePort: await closedPort(), tls: null });
    try {
      expect(proxy.intercepting).toBe(false);
      const h = await fetch(`http://127.0.0.1:${proxy.port}/health`);
      expect(await h.json()).toMatchObject({ intercepting: false });
    } finally { await proxy.close(); }
  });
});

/** What a CONNECT to `authority` gets back, head only. */
async function connectHead(proxy: ExternalProxy, authority: string): Promise<string> {
  const socket = net.connect(proxy.port, "127.0.0.1");
  try {
    return await new Promise<string>((resolve) => {
      socket.once("data", (d) => resolve(d.toString()));
      socket.once("close", () => resolve(""));
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nhost: ${authority}\r\n\r\n`);
    });
  } finally { socket.destroy(); }
}

describe("CONNECT toward this machine", () => {
  test("loopback, private and link-local targets are refused with a 403, and nothing is opened toward them", async () => {
    let reached = 0;
    const target = net.createServer((s) => { reached++; s.on("error", () => {}); s.end(); });
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
    const port = (target.address() as net.AddressInfo).port;
    const { proxy, lines } = await start({ enginePort: await closedPort() });
    try {
      const refused = [
        `127.0.0.1:${port}`, `127.8.8.8:${port}`, `[::1]:${port}`, `localhost:${port}`, `LocalHost.:${port}`, `admin.localhost:${port}`,
        "0.0.0.0:3333", `[::]:${port}`, `[::ffff:127.0.0.1]:${port}`, `[::ffff:7f00:1]:${port}`,
        "10.0.0.5:443", "172.16.0.1:443", "172.31.255.255:443", "192.168.1.10:443", "169.254.169.254:80",
        "[fe80::1]:443", "[fd12:3456::1]:443",
        // not an address to the eye, but the system resolver turns them into 127.0.0.1: caught on what they RESOLVE to
        `2130706433:${port}`, `127.1:${port}`,
      ];
      for (const authority of refused) {
        const head = await connectHead(proxy, authority);
        expect({ authority, head: head.split("\r\n")[0] }).toEqual({ authority, head: "HTTP/1.1 403 Forbidden" });
      }
      expect(reached).toBe(0);
      expect(proxy.stats.refused).toBe(refused.length);
      expect(proxy.stats.tunnel).toBe(0);
      expect(lines.filter((l) => l.startsWith("connect-refused "))).toHaveLength(refused.length);
      // the main port of Topics is the reason: the loopback is trusted there, so a tunnel into it must not exist
      expect((await connectHead(proxy, `127.0.0.1:${proxy.port}`)).startsWith("HTTP/1.1 403")).toBe(true);
    } finally { await proxy.close(); target.close(); }
  });

  test("the address classifier: the edges of every range, and what is public stays public", () => {
    for (const address of ["127.0.0.1", "127.255.255.255", "0.0.0.0", "10.255.255.255", "172.16.0.0", "172.31.255.255", "192.168.0.1",
      "169.254.0.1", "::1", "::", "fe80::1", "febf::1", "fc00::1", "fdff::1", "::ffff:127.0.0.1", "::ffff:192.168.1.1", "fe80::1%en0"]) {
      expect({ address, blocked: isLocalOrPrivateAddress(address) }).toEqual({ address, blocked: true });
    }
    for (const address of ["8.8.8.8", "1.1.1.1", "172.15.255.255", "172.32.0.0", "192.169.0.1", "11.0.0.1", "169.255.0.1", "100.64.0.1",
      "2606:4700::1111", "fec0::1", "fe00::1", "::ffff:8.8.8.8", "not-an-address", "example.com"]) {
      expect({ address, blocked: isLocalOrPrivateAddress(address) }).toEqual({ address, blocked: false });
    }
  });

  test("the lookup the tunnel connects through: a public answer passes, in both shapes of the callback, a local one is refused", async () => {
    const run = (host: string, all: boolean) => new Promise<{ error?: NodeJS.ErrnoException; result?: unknown }>((resolve) => {
      (guardedLookup as (h: string, o: object, cb: (e: NodeJS.ErrnoException | null, a?: unknown, f?: number) => void) => void)(
        host, { all }, (error, address, family) => resolve(error ? { error } : { result: all ? address : [address, family] }),
      );
    });
    expect((await run("8.8.8.8", true)).result).toEqual([{ address: "8.8.8.8", family: 4 }]);
    expect((await run("8.8.8.8", false)).result).toEqual(["8.8.8.8", 4]);
    expect((await run("127.0.0.1", false)).error?.code).toBe("ETOPICSBLOCKED");
    expect((await run("localhost", true)).error?.code).toBe("ETOPICSBLOCKED"); // ::1 AND 127.0.0.1 behind one name
  });

  test("api.anthropic.com itself is not caught by the guard: it ends in the internal listener, on the loopback, by design", async () => {
    const upstream = fake(() => new Response("anthropic"));
    const { proxy } = await start({ enginePort: await closedPort(), upstreamPort: upstream.port });
    try {
      const r = await viaProxy(proxy, "/api/oauth/profile", { method: "GET" });
      expect(await r.text()).toBe("anthropic");
      expect(proxy.stats.refused).toBe(0);
      expect(proxy.stats.intercepted).toBe(1);
    } finally { await proxy.close(); upstream.stop(); }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// WebSocket: a minimal client by hand, because the point is the handshake the proxy answers (101), not a client library
// ---------------------------------------------------------------------------------------------------------------------

/** CONNECT api.anthropic.com:443 through the proxy and finish the TLS with our CA: what the app's HTTP stack does. */
async function secureSocketViaProxy(proxy: ExternalProxy): Promise<tls.TLSSocket> {
  const raw = net.connect(proxy.port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    raw.once("error", reject);
    raw.once("data", (d) => (d.toString().startsWith("HTTP/1.1 200") ? resolve() : reject(new Error(`CONNECT: ${d.toString()}`))));
    raw.write("CONNECT api.anthropic.com:443 HTTP/1.1\r\nhost: api.anthropic.com:443\r\n\r\n");
  });
  const secure = tls.connect({ socket: raw, servername: "api.anthropic.com", ca: readFileSync(leaf.caCertificatePath, "utf8") });
  await new Promise<void>((resolve, reject) => { secure.once("secureConnect", resolve); secure.once("error", reject); });
  return secure;
}

/** Reads what arrives on a socket as: one HTTP head, then WebSocket frames. */
class Wire {
  private buffer = Buffer.alloc(0);
  private waiting: (() => void) | null = null;
  constructor(readonly socket: net.Socket) {
    socket.on("data", (d: Buffer) => { this.buffer = Buffer.concat([this.buffer, d]); this.waiting?.(); });
    socket.on("close", () => this.waiting?.());
    socket.on("error", () => {});
  }
  private async until(ready: () => boolean): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!ready()) {
      if (Date.now() > deadline || this.socket.destroyed) throw new Error("wire: nothing more arrived");
      await new Promise<void>((resolve) => { this.waiting = resolve; setTimeout(resolve, 100); });
    }
  }
  async head(): Promise<string> {
    await this.until(() => this.buffer.indexOf("\r\n\r\n") !== -1);
    const end = this.buffer.indexOf("\r\n\r\n");
    const head = this.buffer.subarray(0, end).toString("latin1");
    this.buffer = this.buffer.subarray(end + 4);
    return head;
  }
  /** One unfragmented, unmasked server frame with a short payload. */
  async frame(): Promise<{ opcode: number; payload: Buffer }> {
    await this.until(() => this.buffer.length >= 2 && this.buffer.length >= 2 + (this.buffer[1]! & 0x7f));
    const length = this.buffer[1]! & 0x7f;
    const frame = { opcode: this.buffer[0]! & 0x0f, payload: Buffer.from(this.buffer.subarray(2, 2 + length)) };
    this.buffer = this.buffer.subarray(2 + length);
    return frame;
  }
}

/** A masked client frame (the protocol requires the mask), short payloads only. */
function clientFrame(opcode: number, payload: Buffer): Buffer {
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  const masked = Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]!));
  return Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | payload.length]), mask, masked]);
}

function upgradeRequest(path: string, extra: Record<string, string> = {}): string {
  const headers = {
    host: "api.anthropic.com", upgrade: "websocket", connection: "Upgrade", "sec-websocket-version": "13",
    "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", authorization: `Bearer ${CALLER_AUTH}`, ...extra,
  };
  return `GET ${path} HTTP/1.1\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`;
}

/** A fake api.anthropic.com that speaks WebSocket: greets on open, echoes with a prefix, records the handshake and the close. */
function fakeWebSocketUpstream(opts: { protocol?: string; refuse?: boolean } = {}) {
  const handshakes: { path: string; headers: Headers }[] = [];
  const closed: { code: number; reason: string }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      handshakes.push({ path: new URL(req.url).pathname + new URL(req.url).search, headers: req.headers });
      if (opts.refuse) return new Response("no", { status: 401 });
      if (srv.upgrade(req, { headers: opts.protocol ? { "sec-websocket-protocol": opts.protocol } : undefined })) return undefined;
      return new Response("not a websocket", { status: 400 });
    },
    websocket: {
      open(ws) { ws.send("hello"); },
      message(ws, message) { ws.send(typeof message === "string" ? `echo:${message}` : message); },
      close(_ws, code, reason) { closed.push({ code, reason }); },
    },
  });
  return { port: server.port as number, handshakes, closed, stop: () => server.stop(true) };
}

describe("WebSocket", () => {
  test("an upgrade toward api.anthropic.com gets its 101, and messages travel both ways, text and binary", async () => {
    const ws = fakeWebSocketUpstream({ protocol: "v2" });
    const { proxy, lines } = await start({ enginePort: await closedPort(), upstreamPort: ws.port });
    try {
      const secure = await secureSocketViaProxy(proxy);
      const wire = new Wire(secure);
      secure.write(upgradeRequest("/v1/ws/session?org=11111111-2222-3333-4444-555555555555", { "sec-websocket-protocol": "v1, v2", "x-app": "cli" }));
      const head = await wire.head();
      expect(head.split("\r\n")[0]).toBe("HTTP/1.1 101 Switching Protocols");
      // the subprotocol is the one the upstream chose, not the first one offered
      expect(head.toLowerCase()).toContain("sec-websocket-protocol: v2");

      // sent by the upstream the moment it opened, possibly before the client side was ready: it must not be lost
      const hello = await wire.frame();
      expect([hello.opcode, hello.payload.toString()]).toEqual([1, "hello"]);
      secure.write(clientFrame(1, Buffer.from("ciao è ☃")));
      const echoed = await wire.frame();
      expect([echoed.opcode, echoed.payload.toString()]).toEqual([1, "echo:ciao è ☃"]);
      const bytes = Buffer.from([0, 1, 2, 250, 255]);
      secure.write(clientFrame(2, bytes));
      const binary = await wire.frame();
      expect(binary.opcode).toBe(2);
      expect(binary.payload.equals(bytes)).toBe(true);

      // the handshake that reached the upstream: the same path and query, the caller's credentials and headers, our own protocol headers
      expect(ws.handshakes).toHaveLength(1);
      const seen = ws.handshakes[0]!;
      expect(seen.path).toBe("/v1/ws/session?org=11111111-2222-3333-4444-555555555555");
      expect(seen.headers.get("authorization")).toBe(`Bearer ${CALLER_AUTH}`);
      expect(seen.headers.get("x-app")).toBe("cli");
      expect(seen.headers.get("sec-websocket-protocol")).toContain("v1");
      expect(seen.headers.get("sec-websocket-key")).not.toBe("dGhlIHNhbXBsZSBub25jZQ=="); // the proxy opened its own handshake

      // the client closes with 1000: the upstream sees it
      secure.write(clientFrame(8, Buffer.from([0x03, 0xe8])));
      for (let i = 0; i < 40 && ws.closed.length === 0; i++) await sleep(50);
      expect(ws.closed[0]?.code).toBe(1000);
      secure.destroy();

      expect(proxy.stats.websocket).toBe(1);
      const all = lines.join("\n");
      expect(all).toContain("ws ");
      expect(all).toContain("/v1/ws/session");
      expect(all).not.toContain("org=");
      expect(all).not.toContain("11111111-2222-3333-4444-555555555555");
      expect(all).not.toContain(CALLER_AUTH);
    } finally { await proxy.close(); ws.stop(); }
  });

  test("the upstream that closes ends the client side too, with the same code and reason", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, srv) { return srv.upgrade(req) ? undefined : new Response("no", { status: 400 }); },
      websocket: { open(ws) { ws.close(4001, "bye now"); }, message() {} },
    });
    const { proxy } = await start({ enginePort: await closedPort(), upstreamPort: server.port as number });
    try {
      const secure = await secureSocketViaProxy(proxy);
      const wire = new Wire(secure);
      secure.write(upgradeRequest("/v1/ws"));
      expect((await wire.head()).split("\r\n")[0]).toBe("HTTP/1.1 101 Switching Protocols");
      const close = await wire.frame();
      expect(close.opcode).toBe(8);
      expect(close.payload.readUInt16BE(0)).toBe(4001);
      expect(close.payload.subarray(2).toString()).toBe("bye now");
      secure.destroy();
    } finally { await proxy.close(); server.stop(true); }
  });

  test("an upstream that refuses the handshake is a 502 to the client, never a 101 that dies after", async () => {
    const ws = fakeWebSocketUpstream({ refuse: true });
    const { proxy, lines } = await start({ enginePort: await closedPort(), upstreamPort: ws.port });
    try {
      const secure = await secureSocketViaProxy(proxy);
      const wire = new Wire(secure);
      secure.write(upgradeRequest("/v1/ws"));
      expect((await wire.head()).split("\r\n")[0]).toMatch(/^HTTP\/1\.1 502/);
      expect(proxy.stats.websocket).toBe(0);
      expect(lines.some((l) => l.startsWith("ws-error "))).toBe(true);
      secure.destroy();
    } finally { await proxy.close(); ws.stop(); }
  });

  test("a request that is not an upgrade still goes the normal way on the same connection", async () => {
    const ws = fakeWebSocketUpstream();
    const { proxy } = await start({ enginePort: await closedPort(), upstreamPort: ws.port });
    try {
      const r = await viaProxy(proxy, "/api/oauth/profile", { method: "GET" });
      expect(r.status).toBe(400); // the fake answers a plain GET with its "not a websocket": it arrived as a plain request
      expect(await r.text()).toBe("not a websocket");
    } finally { await proxy.close(); ws.stop(); }
  });
});

describe("fail-open", () => {
  test("engine down: the request goes straight to Anthropic with the original headers, and it is noted", async () => {
    const upstream = fake(() => Response.json({ via: "anthropic" }));
    const { proxy, lines } = await start({ enginePort: await closedPort(), upstreamPort: upstream.port });
    try {
      const payload = JSON.stringify({ model: "claude-haiku-4-5", messages: [{ role: "user", content: "segretissimo" }] });
      const t0 = Date.now();
      const r = await viaProxy(proxy, "/v1/messages?beta=true", { body: payload, headers: { "content-type": "application/json" } });
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ via: "anthropic" });
      expect(Date.now() - t0).toBeLessThan(1500); // a closed port is understood at once, not after 2 s
      expect(upstream.seen).toHaveLength(1);
      expect(upstream.seen[0]!.body).toBe(payload);
      expect(upstream.seen[0]!.headers.get("authorization")).toBe(`Bearer ${CALLER_AUTH}`);
      expect(upstream.seen[0]!.headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
      expect(proxy.stats.failOpen).toBe(1);
      expect(lines.filter((l) => l.startsWith("fail-open "))).toHaveLength(1);

      const org = "11111111-2222-3333-4444-555555555555";
      await viaProxy(proxy, `/api/oauth/organizations/${org}/marketplaces?x=1`, { method: "GET" });
      const all = lines.join("\n");
      expect(all).not.toContain(CALLER_AUTH);
      expect(all).not.toContain("segretissimo");
      expect(all).not.toContain("beta=true");
      expect(all).not.toContain(org);
      expect(all).toContain("/api/oauth/organizations/:id/marketplaces");
    } finally { await proxy.close(); upstream.stop(); }
  });

  test("engine closes the connection before answering: fail-open", async () => {
    const dropper = net.createServer((s) => s.once("data", () => s.destroy()));
    await new Promise<void>((r) => dropper.listen(0, "127.0.0.1", r));
    const upstream = fake(() => new Response("ok-anthropic"));
    const { proxy, lines } = await start({ enginePort: (dropper.address() as net.AddressInfo).port, upstreamPort: upstream.port });
    try {
      const r = await viaProxy(proxy, "/v1/messages", { body: "{}" });
      expect(await r.text()).toBe("ok-anthropic");
      expect(upstream.seen).toHaveLength(1);
      expect(lines.some((l) => l.startsWith("fail-open "))).toBe(true);
    } finally { await proxy.close(); dropper.close(); upstream.stop(); }
  });

  test("engine accepts but stays mute, /health mute too: it is bypassed after silenceMs", async () => {
    const mute = net.createServer((s) => s.on("error", () => {}));
    await new Promise<void>((r) => mute.listen(0, "127.0.0.1", r));
    const upstream = fake(() => new Response("ok-anthropic"));
    const { proxy, lines } = await start({
      enginePort: (mute.address() as net.AddressInfo).port, upstreamPort: upstream.port, silenceMs: 150, healthMs: 150,
    });
    try {
      const t0 = Date.now();
      const r = await viaProxy(proxy, "/v1/messages", { body: "{}" });
      expect(await r.text()).toBe("ok-anthropic");
      const ms = Date.now() - t0;
      expect(ms).toBeGreaterThanOrEqual(250); // 150 ms of waiting + 150 ms of /health
      expect(ms).toBeLessThan(1500);
      expect(lines.find((l) => l.startsWith("fail-open "))).toContain("no-response-health-down");
    } finally { await proxy.close(); mute.close(); upstream.stop(); }
  });

  test("a SLOW engine answer is not a fault: while /health answers it waits, with no second send", async () => {
    const engine = fake(async (req) => {
      if (new URL(req.url).pathname === "/health") return Response.json({ status: "ok" });
      await sleep(700); // usage cap waiting
      return Response.json({ via: "engine-slow" });
    });
    const upstream = fake(() => new Response("anthropic"));
    const { proxy } = await start({ enginePort: engine.port, upstreamPort: upstream.port, silenceMs: 150, healthMs: 150 });
    try {
      const r = await viaProxy(proxy, "/v1/messages", { body: "{}" });
      expect(await r.json()).toEqual({ via: "engine-slow" });
      expect(upstream.seen).toHaveLength(0); // the request must not run twice
      expect(engine.seen.filter((s) => s.url === "/v1/messages")).toHaveLength(1);
      expect(engine.seen.filter((s) => s.url === "/health")).toHaveLength(1); // at 150 ms /health was asked
      expect(proxy.stats.failOpen).toBe(0);
    } finally { await proxy.close(); engine.stop(); upstream.stop(); }
  });
});

describe("streamed answers", () => {
  const pieces = ['event: message_start\ndata: {"type":"mess', 'age_start"}\n\n', 'event: content_block_delta\ndata: {"d":"ciao"}\n\n', "event: message_stop\ndata: {}\n\n"];

  function sseResponse(wrote: number[]): Response {
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({
      async start(c) {
        for (const piece of pieces) { c.enqueue(encoder.encode(piece)); wrote.push(Date.now()); await sleep(150); }
        c.close();
      },
    }), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
  }

  async function readPieces(r: Response) {
    const reader = r.body!.getReader();
    const arrived: { at: number; text: string }[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arrived.push({ at: Date.now(), text: new TextDecoder().decode(value) });
    }
    return arrived;
  }

  test("SSE from the engine: every piece reaches the client as it is written, in order, not merged", async () => {
    const wrote: number[] = [];
    const engine = fake(() => sseResponse(wrote));
    const { proxy } = await start({ enginePort: engine.port });
    try {
      const r = await viaProxy(proxy, "/v1/messages", { body: '{"stream":true}' });
      expect(r.headers.get("content-type")).toBe("text/event-stream");
      const arrived = await readPieces(r);
      expect(arrived.map((a) => a.text).join("")).toBe(pieces.join(""));
      expect(arrived.length).toBeGreaterThanOrEqual(3);
      // buffering would mean: the first byte after the last write. It has to arrive well before.
      expect(arrived[0]!.at).toBeLessThan(wrote[wrote.length - 1]! - 100);
    } finally { await proxy.close(); engine.stop(); }
  });

  test("SSE also on the fail-open path (straight to Anthropic)", async () => {
    const wrote: number[] = [];
    const upstream = fake(() => sseResponse(wrote));
    const { proxy } = await start({ enginePort: await closedPort(), upstreamPort: upstream.port });
    try {
      const r = await viaProxy(proxy, "/v1/messages", { body: '{"stream":true}' });
      const arrived = await readPieces(r);
      expect(arrived.map((a) => a.text).join("")).toBe(pieces.join(""));
      expect(arrived.length).toBeGreaterThanOrEqual(3);
      expect(arrived[0]!.at).toBeLessThan(wrote[wrote.length - 1]! - 100);
    } finally { await proxy.close(); upstream.stop(); }
  });
});

describe("CA and state", () => {
  test("the CA is bound to api.anthropic.com, keys are 0600, a second start does not rebuild the files", () => {
    const caDir = join(dir, "ca");
    expect(statSync(caDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(caDir, "ca-key.pem")).mode & 0o777).toBe(0o600);
    expect(statSync(leaf.leafKeyPath).mode & 0o777).toBe(0o600);
    const before = readFileSync(leaf.leafCertificatePath);
    ensureExternalProxyLeaf(caDir);
    expect(readFileSync(leaf.leafCertificatePath).equals(before)).toBe(true);

    // the CA signs a certificate for another site, but no verifier accepts it
    const other = ensureExternalProxyLeaf(caDir, "example.com");
    let rejected = false;
    try {
      execFileSync("openssl", ["verify", "-CAfile", leaf.caCertificatePath, other.leafCertificatePath], { stdio: "pipe" });
    } catch { rejected = true; }
    expect(rejected).toBe(true);
    const ok = execFileSync("openssl", ["verify", "-CAfile", leaf.caCertificatePath, leaf.leafCertificatePath], { encoding: "utf8" });
    expect(ok).toMatch(/OK/);
  });

  test("boot writes host, port and CA path where other tools read them, and the file goes away on close", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "external-proxy-state-"));
    try {
      const booted = await bootExternalProxy({ homeDir, port: 0 });
      const file = externalProxyStatePath(homeDir);
      const state = JSON.parse(readFileSync(file, "utf8"));
      expect(state).toMatchObject({ host: "127.0.0.1", port: booted.port, intercepting: true, pid: process.pid });
      expect(existsSync(state.caCertificatePath)).toBe(true);
      expect(state.caCertificatePath).toBe(join(homeDir, "external-proxy-ca", "ca.pem"));
      expect(statSync(join(homeDir, "external-proxy-ca")).mode & 0o777).toBe(0o700);
      const health = await fetch(`http://127.0.0.1:${state.port}/health`);
      expect(health.status).toBe(200);
      await booted.close();
      expect(existsSync(file)).toBe(false);
    } finally { rmSync(homeDir, { recursive: true, force: true }); }
  });

  test("a port still held by the previous server process is retried, and the state appears only once listening", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "external-proxy-state-"));
    const holder = net.createServer();
    await new Promise<void>((r) => holder.listen(0, "127.0.0.1", r));
    const port = (holder.address() as net.AddressInfo).port;
    try {
      const pending = bootExternalProxy({ homeDir, port, bindRetries: 30, bindRetryMs: 100 });
      await sleep(250);
      expect(existsSync(externalProxyStatePath(homeDir))).toBe(false);
      await new Promise((r) => holder.close(r));
      const booted = await pending;
      expect(booted.port).toBe(port);
      expect(existsSync(externalProxyStatePath(homeDir))).toBe(true);
      await booted.close();
    } finally { holder.close(); rmSync(homeDir, { recursive: true, force: true }); }
  });

  test("the port variable: unset, empty or invalid means off", () => {
    expect(externalProxyPort({})).toBeNull();
    expect(externalProxyPort({ TOPICS_EXTERNAL_PROXY_PORT: "" })).toBeNull();
    expect(externalProxyPort({ TOPICS_EXTERNAL_PROXY_PORT: "abc" })).toBeNull();
    expect(externalProxyPort({ TOPICS_EXTERNAL_PROXY_PORT: "70000" })).toBeNull();
    expect(externalProxyPort({ TOPICS_EXTERNAL_PROXY_PORT: "3350" })).toBe(3350);
  });
});
