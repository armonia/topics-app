/** @covers MP-NET-01 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import net from "node:net";
import {
  connectFirstReachable,
  egressProxyEnv,
  interleaveFamilies,
  parseConnectTarget,
  startEgressProxy,
  type Dial,
  type EgressProxy,
} from "./egress-proxy";

// A socket that never connects nor fails: what a port silently dropped by the
// network looks like from here (no RST, no ICMP, just nothing).
function droppedSocket(): net.Socket {
  return new net.Socket();
}

let echo: net.Server;
let echoPort: number;
let closedPort: number;

beforeAll(async () => {
  echo = net.createServer((s) => s.pipe(s));
  await new Promise<void>((r) => echo.listen(0, "127.0.0.1", () => r()));
  echoPort = (echo.address() as net.AddressInfo).port;
  // A port that was just free: connecting to it is refused at once.
  const probe = net.createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
  closedPort = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
}, 30_000);

afterAll(async () => {
  await new Promise<void>((r) => echo.close(() => r()));
});

// "dead" is dropped silently, "refused" answers RST, anything else is the echo server.
const fakeNet: Dial = (ip) => {
  if (ip === "dead") return droppedSocket();
  if (ip === "refused") return net.connect({ host: "127.0.0.1", port: closedPort });
  return net.connect({ host: "127.0.0.1", port: echoPort });
};

describe("connectFirstReachable", () => {
  test("a silently dropped first address costs one attempt delay, not the connection", async () => {
    const started = Date.now();
    const socket = await connectFirstReachable("chatgpt.test", 443, {
      resolve: async () => ["dead", "live"],
      dial: fakeNet,
      attemptDelayMs: 100,
      timeoutMs: 15_000,
    });
    // No upper bound on purpose: without the stagger the dead address holds the
    // race until the deadline rejects, so reaching here is the proof.
    expect(socket.remotePort).toBe(echoPort);
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
    socket.destroy();
  }, 30_000);

  test("a refused address hands over at once, without waiting the attempt delay", async () => {
    const started = Date.now();
    const socket = await connectFirstReachable("chatgpt.test", 443, {
      resolve: async () => ["refused", "live"],
      dial: fakeNet,
      attemptDelayMs: 30_000,
      timeoutMs: 60_000,
    });
    // Far below the 30 s delay even on a saturated machine: the RST handed over.
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(socket.remotePort).toBe(echoPort);
    socket.destroy();
  }, 60_000);

  test("the losing attempts are destroyed once one wins", async () => {
    const dialed: net.Socket[] = [];
    const socket = await connectFirstReachable("chatgpt.test", 443, {
      resolve: async () => ["dead", "live"],
      dial: (ip, port) => { const s = fakeNet(ip, port); dialed.push(s); return s; },
      attemptDelayMs: 20,
    });
    expect(dialed).toHaveLength(2);
    expect(dialed[0]!.destroyed).toBe(true);
    expect(socket.destroyed).toBe(false);
    socket.destroy();
  });

  test("every address dead rejects at the deadline, naming the addresses", async () => {
    const started = Date.now();
    await expect(connectFirstReachable("chatgpt.test", 443, {
      resolve: async () => ["dead", "dead"],
      dial: fakeNet,
      attemptDelayMs: 20,
      timeoutMs: 300,
    })).rejects.toThrow("no address answered within 300 ms (dead, dead)");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test("every address refused rejects at once with each failure", async () => {
    await expect(connectFirstReachable("chatgpt.test", 443, {
      resolve: async () => ["refused"],
      dial: fakeNet,
      timeoutMs: 5_000,
    })).rejects.toThrow("every address failed (refused:");
  });

  test("no address at all is an error, not a hang", async () => {
    await expect(connectFirstReachable("chatgpt.test", 443, { resolve: async () => [] }))
      .rejects.toThrow("no address");
  });
});

describe("interleaveFamilies", () => {
  test("alternates IPv6 and IPv4, IPv6 first", () => {
    expect(interleaveFamilies([
      { address: "a4", family: 4 }, { address: "b4", family: 4 }, { address: "c4", family: 4 },
      { address: "a6", family: 6 },
    ])).toEqual(["a6", "a4", "b4", "c4"]);
  });
});

describe("parseConnectTarget", () => {
  test("host, IPv6 literal and port", () => {
    expect(parseConnectTarget("CONNECT chatgpt.com:443 HTTP/1.1")).toEqual({ host: "chatgpt.com", port: 443 });
    expect(parseConnectTarget("CONNECT [2606:4700::1]:443 HTTP/1.1")).toEqual({ host: "2606:4700::1", port: 443 });
  });

  test("anything that is not a clean CONNECT is refused", () => {
    expect(parseConnectTarget("GET http://chatgpt.com/ HTTP/1.1")).toBeNull();
    expect(parseConnectTarget("CONNECT chatgpt.com:0 HTTP/1.1")).toBeNull();
    expect(parseConnectTarget("CONNECT chatgpt.com:70000 HTTP/1.1")).toBeNull();
    expect(parseConnectTarget("CONNECT chatgpt.com HTTP/1.1")).toBeNull();
    expect(parseConnectTarget("CONNECT a b:443 HTTP/1.1")).toBeNull();
    expect(parseConnectTarget("CONNECT chatgpt.com:443\r\nX: y HTTP/1.1")).toBeNull();
  });
});

describe("egressProxyEnv", () => {
  test("points HTTPS at the proxy and keeps loopback direct", () => {
    expect(egressProxyEnv("http://u:p@127.0.0.1:1", {})).toEqual({
      HTTPS_PROXY: "http://u:p@127.0.0.1:1",
      https_proxy: "http://u:p@127.0.0.1:1",
      NO_PROXY: "localhost,127.0.0.1,::1",
      no_proxy: "localhost,127.0.0.1,::1",
    });
    expect(egressProxyEnv("http://x", { NO_PROXY: "corp.local" }).NO_PROXY).toBe("corp.local,localhost,127.0.0.1,::1");
  });

  test("a proxy the user configured wins", () => {
    expect(egressProxyEnv("http://x", { HTTPS_PROXY: "http://corp:3128" })).toEqual({});
    expect(egressProxyEnv("http://x", { all_proxy: "socks5://corp:1080" })).toEqual({});
  });
});

describe("the proxy server", () => {
  let proxy: EgressProxy;
  let port: number;
  let auth: string;

  beforeAll(async () => {
    proxy = await startEgressProxy({
      dial: { resolve: async () => ["dead", "live"], dial: fakeNet, attemptDelayMs: 50 },
    });
    const url = new URL(proxy.url);
    port = Number(url.port);
    auth = "Basic " + Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64");
  }, 30_000);

  afterAll(() => proxy.close());

  // Sends `request`, then `payload` once the proxy answered; resolves with everything read.
  function talk(request: string, payload = ""): Promise<string> {
    return new Promise((resolve, reject) => {
      const c = net.connect({ host: "127.0.0.1", port });
      let got = "";
      let sentPayload = false;
      c.on("data", (d) => {
        got += d.toString();
        // No payload: the status line is the answer; an open tunnel must not hang the test.
        if (!payload && got.includes("\r\n\r\n")) { c.destroy(); resolve(got); return; }
        if (payload && !sentPayload && got.includes("\r\n\r\n")) { sentPayload = true; c.write(payload); }
        if (payload && got.endsWith(payload)) c.end();
      });
      c.on("end", () => resolve(got));
      c.on("error", reject);
      c.write(request);
    });
  }

  test("only binds loopback and hands out credentials", () => {
    expect(proxy.url).toMatch(/^http:\/\/topics:[A-Za-z0-9_-]+@127\.0\.0\.1:\d+$/);
  });

  test("tunnels past the dead address to the live one", async () => {
    const got = await talk(`CONNECT chatgpt.test:443 HTTP/1.1\r\nHost: chatgpt.test:443\r\nProxy-Authorization: ${auth}\r\n\r\n`, "ping");
    expect(got).toBe("HTTP/1.1 200 Connection Established\r\n\r\nping");
  });

  test("bytes sent right behind the header are not lost", async () => {
    const got = await new Promise<string>((resolve, reject) => {
      const c = net.connect({ host: "127.0.0.1", port });
      let received = "";
      c.on("data", (d) => { received += d.toString(); if (received.endsWith("early")) c.end(); });
      c.on("end", () => resolve(received));
      c.on("error", reject);
      c.write(`CONNECT chatgpt.test:443 HTTP/1.1\r\nProxy-Authorization: ${auth}\r\n\r\nearly`);
    });
    expect(got).toBe("HTTP/1.1 200 Connection Established\r\n\r\nearly");
  });

  test("no credentials: 407, nothing dialed", async () => {
    const got = await talk("CONNECT chatgpt.test:443 HTTP/1.1\r\n\r\n");
    expect(got).toStartWith("HTTP/1.1 407 ");
  });

  test("a wrong secret: 407", async () => {
    const wrong = "Basic " + Buffer.from("topics:guess").toString("base64");
    const got = await talk(`CONNECT chatgpt.test:443 HTTP/1.1\r\nProxy-Authorization: ${wrong}\r\n\r\n`);
    expect(got).toStartWith("HTTP/1.1 407 ");
  });

  test("plain HTTP forwarding is not offered", async () => {
    const got = await talk(`GET http://chatgpt.test/ HTTP/1.1\r\nProxy-Authorization: ${auth}\r\n\r\n`);
    expect(got).toStartWith("HTTP/1.1 405 ");
  });
});
