/**
 * The proxy for Claude Code sessions outside Topics: forwarding to the account
 * engine, byte tunnels, fail-open, streamed answers, CA permissions.
 *
 * Everything runs on ephemeral ports of 127.0.0.1 with a fake engine and a fake
 * api.anthropic.com (plain HTTP behind `upstreamBase`): no network, no real :3336.
 * The client is Bun's own `fetch` with `proxy` + `tls.ca`, which is what the
 * bundled Claude binary does with `HTTPS_PROXY` + `NODE_EXTRA_CA_CERTS`.
 *
 * @covers EXTPROXY-01
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import net from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureExternalProxyLeaf, type ExternalProxyLeaf } from "./external-proxy-ca";
import {
  bootExternalProxy, externalProxyPort, externalProxyStatePath, startExternalProxy, type ExternalProxy,
  type ExternalProxyOptions,
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
    const { proxy } = await start({ enginePort: await closedPort() });
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
