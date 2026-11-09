/**
 * WebSocket upgrades through the proxy for Claude Code sessions outside Topics: the 101, messages in both
 * directions, close codes, a client that reads slowly. Split from external-proxy.test.ts (size); the fakes
 * and the proxy starter are in external-proxy.harness.ts.
 *
 * The client is a minimal one by hand: the point is the handshake the proxy answers (101) and the frames it
 * relays, not a client library.
 *
 * @covers EXTPROXY-01
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import net from "node:net";
import tls from "node:tls";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureExternalProxyLeaf, type ExternalProxyLeaf } from "./external-proxy-ca";
import type { ExternalProxy } from "./external-proxy";
import { closedPort, sleep, startProxy } from "./external-proxy.harness";

const CALLER_AUTH = "fake-oauth-credential-for-tests";
let dir: string;
let leaf: ExternalProxyLeaf;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "external-proxy-ws-test-"));
  leaf = ensureExternalProxyLeaf(join(dir, "ca"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const start = (extra: Parameters<typeof startProxy>[1]) => startProxy(leaf, extra);

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

/** Reads what arrives on a socket as: one HTTP head, then WebSocket frames (any length), parsed as they come. */
class Wire {
  private buffer = Buffer.alloc(0);
  private headText: string | null = null;
  private readonly queue: { opcode: number; payload: Buffer }[] = [];
  private woken: (() => void) | null = null;
  constructor(readonly socket: net.Socket) {
    socket.on("data", (d: Buffer) => { this.buffer = Buffer.concat([this.buffer, d]); this.parse(); this.woken?.(); });
    socket.on("close", () => this.woken?.());
    socket.on("error", () => {});
  }
  private parse(): void {
    if (this.headText === null) {
      const end = this.buffer.indexOf("\r\n\r\n");
      if (end === -1) return;
      this.headText = this.buffer.subarray(0, end).toString("latin1");
      this.buffer = this.buffer.subarray(end + 4);
    }
    for (;;) {
      if (this.buffer.length < 2) return;
      let length = this.buffer[1]! & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        length = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (this.buffer.length < offset + length) return;
      this.queue.push({ opcode: this.buffer[0]! & 0x0f, payload: Buffer.from(this.buffer.subarray(offset, offset + length)) });
      this.buffer = this.buffer.subarray(offset + length);
    }
  }
  private async next<T>(take: () => T | undefined, ms: number): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const got = take();
      if (got !== undefined) return got;
      if (Date.now() > deadline || this.socket.destroyed) throw new Error("wire: nothing more arrived");
      await new Promise<void>((resolve) => { this.woken = resolve; setTimeout(resolve, 100); });
    }
  }
  head(ms = 5000): Promise<string> {
    return this.next(() => this.headText ?? undefined, ms);
  }
  /** The next server frame. */
  frame(ms = 5000): Promise<{ opcode: number; payload: Buffer }> {
    return this.next(() => this.queue.shift(), ms);
  }
}

/** A masked client frame (the protocol requires the mask), short payloads only. */
function clientFrame(opcode: number, payload: Buffer): Buffer {
  // a zero key leaves the payload as it is: the protocol only asks for a key, and a 17 MB XOR in a test is a waste
  const mask = payload.length > 65535 ? Buffer.alloc(4) : Buffer.from([0x11, 0x22, 0x33, 0x44]);
  const masked = payload.length > 65535 ? payload : Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]!));
  let head: Buffer;
  if (payload.length < 126) head = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
  else if (payload.length <= 65535) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 0x80 | 126; head.writeUInt16BE(payload.length, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(payload.length), 2); }
  return Buffer.concat([head, mask, masked]);
}

function upgradeRequest(path: string, extra: Record<string, string> = {}): string {
  const headers = {
    host: "api.anthropic.com", upgrade: "websocket", connection: "Upgrade", "sec-websocket-version": "13",
    "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", authorization: `Bearer ${CALLER_AUTH}`, ...extra,
  };
  return `GET ${path} HTTP/1.1\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`;
}

/** A fake api.anthropic.com that speaks WebSocket: greets on open, echoes with a prefix, records the handshake and the close. */
function fakeWebSocketUpstream(opts: { protocol?: string; refuse?: boolean; dropAfterOpen?: boolean } = {}) {
  const handshakes: { path: string; headers: Headers }[] = [];
  const closed: { code: number; reason: string }[] = [];
  const received: unknown[] = [];
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
      open(ws) {
        ws.send("hello");
        if (opts.dropAfterOpen) setTimeout(() => ws.terminate(), 100); // the TCP connection goes, with no close frame
      },
      message(ws, message) { received.push(message); ws.send(typeof message === "string" ? `echo:${message}` : message); },
      close(_ws, code, reason) { closed.push({ code, reason }); },
    },
  });
  return { port: server.port as number, handshakes, closed, received, stop: () => server.stop(true) };
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

  test("close codes travel both ways: the client's code reaches the upstream, an abnormal drop stays abnormal", async () => {
    const ws = fakeWebSocketUpstream();
    const { proxy } = await start({ enginePort: await closedPort(), upstreamPort: ws.port });
    const closeBody = (code: number, reason: string) => {
      const body = Buffer.alloc(2 + Buffer.byteLength(reason));
      body.writeUInt16BE(code, 0);
      body.write(reason, 2);
      return body;
    };
    /** Opens a relay, lets `act` close it, returns what the upstream saw. */
    const closedBy = async (act: (secure: tls.TLSSocket) => void) => {
      const before = ws.closed.length;
      const secure = await secureSocketViaProxy(proxy);
      const wire = new Wire(secure);
      secure.write(upgradeRequest("/v1/ws"));
      await wire.head();
      await wire.frame(); // "hello": the relay is up on both sides
      act(secure);
      for (let i = 0; i < 60 && ws.closed.length === before; i++) await sleep(50);
      secure.destroy();
      return ws.closed[before];
    };
    try {
      // The code is carried as it is. The reason is handed over whole, but the client socket towards Anthropic
      // is Bun's, which drops a reason of 4 bytes or more on some versions (1.3.8): it is either right or empty, never altered.
      for (const [code, reason] of [[1000, "bye"], [4001, "my reason"], [1001, "navigating away"], [1011, "oops"]] as const) {
        const seen = await closedBy((s) => s.write(clientFrame(8, closeBody(code, reason))));
        expect(seen?.code).toBe(code);
        expect(["", reason]).toContain(seen?.reason);
      }
      // a client that vanishes without a close frame is an abnormal close upstream too, not a polite 1000
      expect((await closedBy((s) => s.destroy()))?.code).toBe(1006);
    } finally { await proxy.close(); ws.stop(); }
  }, 20_000); // five relays in a row: under a loaded machine the default 5 s is not a measure of the proxy

  test("an upstream that drops without a close frame is an ABNORMAL close for the client, never a 1000", async () => {
    const ws = fakeWebSocketUpstream({ dropAfterOpen: true });
    const { proxy } = await start({ enginePort: await closedPort(), upstreamPort: ws.port });
    try {
      const secure = await secureSocketViaProxy(proxy);
      const wire = new Wire(secure);
      secure.write(upgradeRequest("/v1/ws"));
      await wire.head();
      expect((await wire.frame()).payload.toString()).toBe("hello");
      const close = await wire.frame();
      expect(close.opcode).toBe(8);
      expect(close.payload.readUInt16BE(0)).toBe(1011);
      secure.destroy();
    } finally { await proxy.close(); ws.stop(); }
  });

  /** A client that stops reading for `pauseMs` while the upstream sends `count` messages of 256 KB, each numbered. */
  async function slowClientRun(opts: { count: number; pauseMs: number; relayBacklogLimitBytes?: number }) {
    const size = 256 * 1024;
    const upstreamClosed: { code: number; reason: string }[] = [];
    const upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, srv) { return srv.upgrade(req) ? undefined : new Response("no", { status: 400 }); },
      websocket: {
        async open(ws) {
          for (let i = 0; i < opts.count; i++) {
            const body = Buffer.alloc(size, 0x61);
            body.writeUInt32BE(i, 0);
            ws.send(body);
            while (ws.getBufferedAmount() > 1024 * 1024) await sleep(5); // the fake respects ITS OWN backpressure: nothing is lost on its side
          }
          ws.send("DONE");
        },
        message() {},
        close(_ws, code, reason) { upstreamClosed.push({ code, reason }); },
      },
    });
    const { proxy, lines } = await start({ enginePort: await closedPort(), upstreamPort: upstream.port as number, relayBacklogLimitBytes: opts.relayBacklogLimitBytes });
    try {
      const secure = await secureSocketViaProxy(proxy);
      const wire = new Wire(secure);
      secure.write(upgradeRequest("/v1/ws"));
      await wire.head();
      secure.pause();
      await sleep(opts.pauseMs);
      secure.resume();
      const sequence: number[] = [];
      let end: { opcode: number; code?: number; text?: string } | null = null;
      while (!end) {
        const frame = await wire.frame(20_000);
        if (frame.opcode === 2) sequence.push(frame.payload.readUInt32BE(0));
        else if (frame.opcode === 8) end = { opcode: 8, code: frame.payload.readUInt16BE(0) };
        else if (frame.opcode === 1) end = { opcode: 1, text: frame.payload.toString() };
      }
      secure.destroy();
      // what Anthropic was told takes a moment: it is still sending, and reads the close frame behind its own backlog
      for (let i = 0; i < 100 && upstreamClosed.length === 0 && end.opcode === 8; i++) await sleep(50);
      return { sequence, end, lines, upstreamClosed };
    } finally { await proxy.close(); upstream.stop(true); }
  }

  test("a client that stops reading loses NOTHING: 160 messages of 256 KB, 4 s of pause, 160 arrive in order", async () => {
    const run = await slowClientRun({ count: 160, pauseMs: 4000 });
    expect(run.end).toEqual({ opcode: 1, text: "DONE" });
    expect(run.sequence).toEqual(Array.from({ length: 160 }, (_, i) => i));
  }, 60_000);

  test("past the backlog limit the relay CLOSES the connection (1013): the client never sees a hole, only a prefix and the close", async () => {
    const run = await slowClientRun({ count: 160, pauseMs: 3000, relayBacklogLimitBytes: 1024 * 1024 });
    expect(run.end).toEqual({ opcode: 8, code: 1013 });
    expect(run.sequence.length).toBeLessThan(160);
    expect(run.sequence).toEqual(run.sequence.map((_, i) => i)); // contiguous from 0: nothing skipped in the middle
    expect(run.lines.some((l) => l.startsWith("ws-backpressure "))).toBe(true);
    // Anthropic is let go too, with the close we send (1011), or as a drop when it is still busy sending and never reads the close
    expect([1011, 1006]).toContain(run.upstreamClosed[0]?.code);
  }, 60_000);

  test("a message of 16 MB goes through; one byte more is refused with 1009 and never reaches Anthropic", async () => {
    const ws = fakeWebSocketUpstream();
    const { proxy, lines } = await start({ enginePort: await closedPort(), upstreamPort: ws.port });
    const limit = 16 * 1024 * 1024;
    try {
      const secure = await secureSocketViaProxy(proxy);
      secure.on("error", () => {});
      const wire = new Wire(secure);
      secure.write(upgradeRequest("/v1/ws"));
      await wire.head();
      await wire.frame(); // "hello"

      secure.write(clientFrame(2, Buffer.alloc(limit, 0x61)));
      const echoed = await wire.frame(20_000);
      expect([echoed.opcode, echoed.payload.length]).toEqual([2, limit]);
      expect(ws.received).toHaveLength(1);

      secure.write(clientFrame(2, Buffer.alloc(limit + 1, 0x62)));
      const close = await wire.frame(20_000);
      expect(close.opcode).toBe(8);
      expect(close.payload.readUInt16BE(0)).toBe(1009);
      expect(ws.received).toHaveLength(1); // the second one was not handed on, not even in part
      expect(lines.some((l) => l.startsWith("ws-too-big "))).toBe(true);
      secure.destroy();
    } finally { await proxy.close(); ws.stop(); }
  }, 60_000);

  test("at most 16 relays at once: the 17th upgrade is a 503 before Anthropic is even asked, and a closed one frees its place", async () => {
    const ws = fakeWebSocketUpstream();
    const { proxy, lines } = await start({ enginePort: await closedPort(), upstreamPort: ws.port });
    const open = async () => {
      const secure = await secureSocketViaProxy(proxy);
      secure.on("error", () => {});
      const wire = new Wire(secure);
      secure.write(upgradeRequest("/v1/ws"));
      return { secure, wire, status: (await wire.head()).split("\r\n")[0] };
    };
    try {
      const held = [];
      for (let i = 0; i < 16; i++) held.push(await open());
      expect(held.map((h) => h.status)).toEqual(Array(16).fill("HTTP/1.1 101 Switching Protocols"));
      expect(ws.handshakes).toHaveLength(16);

      const refused = await open();
      expect(refused.status).toMatch(/^HTTP\/1\.1 503/);
      expect(ws.handshakes).toHaveLength(16); // the 17th never reached the upstream
      expect(lines.some((l) => l.startsWith("ws-refused "))).toBe(true);
      expect(proxy.stats.websocket).toBe(16);

      // one leaves, one fits again
      held[0]!.secure.destroy();
      for (let i = 0; i < 60 && ws.closed.length === 0; i++) await sleep(50);
      expect((await open()).status).toBe("HTTP/1.1 101 Switching Protocols");
      for (const h of held) h.secure.destroy();
      refused.secure.destroy();
    } finally { await proxy.close(); ws.stop(); }
  }, 30_000);

  test("a request that is not an upgrade still goes the normal way on the same connection", async () => {
    const ws = fakeWebSocketUpstream();
    const { proxy } = await start({ enginePort: await closedPort(), upstreamPort: ws.port });
    try {
      const secure = await secureSocketViaProxy(proxy);
      const wire = new Wire(secure);
      secure.write("GET /api/oauth/profile HTTP/1.1\r\nhost: api.anthropic.com\r\nconnection: close\r\n\r\n");
      // the fake answers a plain GET with its "not a websocket": it arrived as a plain request, not as an upgrade
      expect((await wire.head()).split("\r\n")[0]).toBe("HTTP/1.1 400 Bad Request");
      secure.destroy();
    } finally { await proxy.close(); ws.stop(); }
  });
});
