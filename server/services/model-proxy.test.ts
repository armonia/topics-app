/**
 * The model proxy for paired nodes, against a fake upstream and a fake token source.
 *
 * The security contract is tested on the REAL listener factory (a real Bun server on
 * port 0), not only on the handler: whatever else a loopback caller asks for
 * on that port, it gets 404, and the node's token never reaches the upstream.
 *
 * @covers MACHINE-02
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createModelProxyListener, machineForModelToken, mintModelToken, modelProxyPort, modelTokenPath, revokeModelToken,
  type ModelProxyDeps,
} from "./model-proxy";
import { createMachinesRouter } from "../routes/machines";

const MAC_TOKEN = "mac-oauth-token";
const BODY = JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 5, messages: [{ role: "user", content: "ciao è ☃" }] });

interface Seen { url: string; headers: Headers; body: string }
let seen: Seen[] = [];
let upstreamStatuses: number[] = [];
let sse = false;
let upstream: ReturnType<typeof Bun.serve>;
let stateDir: string;
let proxy: ReturnType<typeof createModelProxyListener>;
let machines: Set<string>;
let recoverCalls: string[];
let accessToken: string | null;
const savedBase = process.env.ANTHROPIC_BASE_URL;

beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      seen.push({ url: req.url, headers: req.headers, body: await req.text() });
      const status = upstreamStatuses.shift() ?? 200;
      if (status !== 200) return new Response(JSON.stringify({ type: "error" }), { status });
      if (sse) {
        const encoder = new TextEncoder();
        return new Response(new ReadableStream({
          async start(c) {
            c.enqueue(encoder.encode("event: ping\ndata: 1\n\n"));
            await Bun.sleep(600);
            c.enqueue(encoder.encode("event: ping\ndata: 2\n\n"));
            c.close();
          },
        }), { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({ id: "msg_1", ok: true });
    },
  });
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${upstream.port}`;
});

afterAll(() => {
  upstream.stop(true);
  if (savedBase === undefined) delete process.env.ANTHROPIC_BASE_URL;
  else process.env.ANTHROPIC_BASE_URL = savedBase;
});

beforeEach(() => {
  seen = [];
  upstreamStatuses = [];
  sse = false;
  stateDir = mkdtempSync(join(tmpdir(), "model-proxy-"));
  machines = new Set(["m1"]);
  recoverCalls = [];
  accessToken = MAC_TOKEN;
  const deps: ModelProxyDeps = {
    stateDir,
    machineExists: (id) => machines.has(id),
    getAccessToken: async () => accessToken,
    recoverAfter401: async (stale) => { recoverCalls.push(stale); return "renewed-token"; },
    log: () => {},
  };
  proxy = createModelProxyListener(0, deps);
});

afterEach(() => {
  proxy.stop(true);
  rmSync(stateDir, { recursive: true, force: true });
});

const call = (path: string, init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${proxy.port}${path}`, { method: "POST", body: BODY, ...init });
const withToken = (token: string, extra: Record<string, string> = {}) => ({
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...extra },
});

describe("authentication", () => {
  test("no token: 401 in the Anthropic error shape, upstream not called", async () => {
    const res = await call("/v1/messages?beta=true");
    expect(res.status).toBe(401);
    const json = await res.json() as { type: string; error: { type: string } };
    expect(json.type).toBe("error");
    expect(json.error.type).toBe("authentication_error");
    expect(seen).toHaveLength(0);
  });

  test("wrong token: 401, upstream not called", async () => {
    mintModelToken(stateDir, "m1");
    const res = await call("/v1/messages", withToken("tmt_not-the-token"));
    expect(res.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  test("a good token whose machine row is gone: 401", async () => {
    const token = mintModelToken(stateDir, "m1");
    machines.delete("m1");
    expect((await call("/v1/messages", withToken(token))).status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  test("x-api-key is accepted as well as the bearer", async () => {
    const token = mintModelToken(stateDir, "m1");
    const res = await call("/v1/messages", { headers: { "x-api-key": token, "content-type": "application/json" } });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
  });

  test("a revoked token stops working", async () => {
    const token = mintModelToken(stateDir, "m1");
    expect(revokeModelToken(stateDir, "m1")).toBe(true);
    expect((await call("/v1/messages", withToken(token))).status).toBe(401);
  });
});

describe("forwarding", () => {
  test("upstream gets the Mac token (not the node one), the oauth beta, and the body byte for byte", async () => {
    const token = mintModelToken(stateDir, "m1");
    const res = await call("/v1/messages?beta=true", withToken(token, {
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "claude-code-20250219",
      "x-api-key": "node-secret",
      cookie: "a=b",
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "msg_1", ok: true });
    expect(seen).toHaveLength(1);
    const [req] = seen;
    expect(req.url).toEndWith("/v1/messages?beta=true");
    expect(req.headers.get("authorization")).toBe(`Bearer ${MAC_TOKEN}`);
    expect(req.headers.get("x-api-key")).toBeNull();
    expect(req.headers.get("cookie")).toBeNull();
    expect(JSON.stringify([...req.headers])).not.toContain(token);
    expect(req.headers.get("anthropic-beta")!.split(",")).toEqual(["claude-code-20250219", "oauth-2025-04-20"]);
    expect(req.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(req.body).toBe(BODY);
  });

  test("count_tokens goes to the sibling path, query kept", async () => {
    const token = mintModelToken(stateDir, "m1");
    expect((await call("/v1/messages/count_tokens?beta=true", withToken(token))).status).toBe(200);
    expect(seen[0].url).toEndWith("/v1/messages/count_tokens?beta=true");
  });

  test("an SSE answer flows incrementally, not buffered", async () => {
    sse = true;
    const token = mintModelToken(stateDir, "m1");
    const res = await call("/v1/messages", withToken(token));
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    // Load-proof: the upstream waits 600 ms between its two events. Buffered,
    // both would reach us together; streamed, the gap between them survives.
    const reader = res.body!.getReader();
    const first = await reader.read();
    const firstAt = Date.now();
    expect(new TextDecoder().decode(first.value)).toContain("data: 1");
    let rest = "";
    let lastAt = firstAt;
    for (let r = await reader.read(); !r.done; r = await reader.read()) {
      rest += new TextDecoder().decode(r.value);
      lastAt = Date.now();
    }
    expect(rest).toContain("data: 2");
    expect(lastAt - firstAt).toBeGreaterThan(400);
  });

  test("a non-claude model: 400, upstream not called", async () => {
    const token = mintModelToken(stateDir, "m1");
    const res = await call("/v1/messages", { ...withToken(token), body: JSON.stringify({ model: "gpt-5", messages: [] }) });
    expect(res.status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  test("a body that is not JSON: 400", async () => {
    const token = mintModelToken(stateDir, "m1");
    expect((await call("/v1/messages", { ...withToken(token), body: "nope" })).status).toBe(400);
  });

  test("a body over the cap: 413", async () => {
    proxy.stop(true);
    const token = mintModelToken(stateDir, "m1");
    proxy = createModelProxyListener(0, {
      stateDir, machineExists: () => true, getAccessToken: async () => MAC_TOKEN, recoverAfter401: async () => null,
      maxBodyBytes: 64, log: () => {},
    });
    const res = await call("/v1/messages", { ...withToken(token), body: JSON.stringify({ model: "claude-x", pad: "x".repeat(200) }) });
    expect(res.status).toBe(413);
    expect(seen).toHaveLength(0);
  });

  test("no Mac login: 503 with a clear message", async () => {
    accessToken = null;
    const token = mintModelToken(stateDir, "m1");
    const res = await call("/v1/messages", withToken(token));
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).toContain("login");
    expect(seen).toHaveLength(0);
  });

  test("an upstream 401 recovers the token and retries once with the new one", async () => {
    upstreamStatuses = [401, 200];
    const token = mintModelToken(stateDir, "m1");
    const res = await call("/v1/messages", withToken(token));
    expect(res.status).toBe(200);
    expect(recoverCalls).toEqual([MAC_TOKEN]);
    expect(seen.map((s) => s.headers.get("authorization"))).toEqual([`Bearer ${MAC_TOKEN}`, "Bearer renewed-token"]);
  });

  test("a second 401 is answered as it is, no third attempt", async () => {
    upstreamStatuses = [401, 401, 200];
    const token = mintModelToken(stateDir, "m1");
    expect((await call("/v1/messages", withToken(token))).status).toBe(401);
    expect(seen).toHaveLength(2);
  });
});

describe("the dedicated listener serves nothing else", () => {
  test("any other path or method: 404, even with a valid token", async () => {
    const token = mintModelToken(stateDir, "m1");
    for (const [method, path] of [
      ["GET", "/api/topics"], ["POST", "/api/topics"], ["GET", "/"], ["GET", "/v1/messages"],
      ["POST", "/v1/messages/batches"], ["POST", "/v1/messages/count_tokens/x"], ["POST", "/__daemon/state"],
      ["POST", "/api/machines/m1/model-token"], ["DELETE", "/v1/messages"],
    ] as const) {
      const res = await fetch(`http://127.0.0.1:${proxy.port}${path}`, { method, body: method === "GET" ? undefined : BODY, ...withToken(token) });
      expect(`${method} ${path} ${res.status}`).toBe(`${method} ${path} 404`);
    }
    expect(seen).toHaveLength(0);
  });

  test("it is bound to loopback only", () => {
    expect(proxy.hostname).toBe("127.0.0.1");
  });

  test("the port is opt-in: unset or invalid means no listener", () => {
    expect(modelProxyPort({})).toBeNull();
    expect(modelProxyPort({ TOPICS_MODEL_PROXY_PORT: "abc" })).toBeNull();
    expect(modelProxyPort({ TOPICS_MODEL_PROXY_PORT: "70000" })).toBeNull();
    expect(modelProxyPort({ TOPICS_MODEL_PROXY_PORT: "18080" })).toBe(18080);
  });
});

describe("token store", () => {
  test("only the SHA-256 is on disk, at 0600, and minting again revokes the old token", () => {
    const first = mintModelToken(stateDir, "m1");
    const file = modelTokenPath(stateDir, "m1");
    const onDisk = readFileSync(file, "utf8");
    expect(onDisk).not.toContain(first);
    expect(onDisk.trim()).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(machineForModelToken(stateDir, first)).toBe("m1");
    const second = mintModelToken(stateDir, "m1");
    expect(machineForModelToken(stateDir, first)).toBeNull();
    expect(machineForModelToken(stateDir, second)).toBe("m1");
  });

  test("a machine id that is not a file name is refused", () => {
    expect(() => modelTokenPath(stateDir, "../x")).toThrow();
  });
});

describe("minting route", () => {
  function routerWith(machineList: Array<{ id: string; baseUrl: string | null }>, owner: boolean | "loopback" = true) {
    const store = {
      get: (id: string) => machineList.find((m) => m.id === id) ?? null,
      delete: (id: string) => machineList.some((m) => m.id === id),
    };
    const json = (data: unknown, status = 200) => Response.json(data, { status });
    const ctx = {
      STATE_DIR: stateDir, machineStore: store, json,
      errorResponse: (status: number, error: string) => json({ error }, status),
      readJSON: async () => null,
      matchRoute: (pathname: string, pattern: string) => {
        const a = pattern.split("/"); const b = pathname.split("/");
        if (a.length !== b.length) return null;
        const params: Record<string, string> = {};
        for (let i = 0; i < a.length; i++) {
          if (a[i].startsWith(":")) params[a[i].slice(1)] = b[i];
          else if (a[i] !== b[i]) return null;
        }
        return params;
      },
      broadcastToAll: () => {},
      requestIdentity: owner === "loopback"
        ? () => ({ role: "owner", deviceId: null })
        : owner ? undefined : () => ({ role: "guest", deviceId: null }),
      // "loopback" models a fresh install: nobody in installation_owners yet.
      db: { query: () => ({ get: () => (owner === "loopback" ? null : { person_id: "p1" }) }) },
    };
    const router = createMachinesRouter(ctx as never);
    return (method: string, path: string) =>
      router(new Request(`http://h${path}`, { method }), new URL(`http://h${path}`), path, method);
  }

  test("an unknown machine is refused and no hash file is written", async () => {
    const res = await routerWith([{ id: "m1", baseUrl: "https://pc:3333" }])("POST", "/api/machines/ghost/model-token");
    expect(res!.status).toBe(404);
    expect(readdirSync(stateDir)).toEqual([]);
  });

  test("the local machine (no baseUrl) cannot get one", async () => {
    const res = await routerWith([{ id: "local", baseUrl: null }])("POST", "/api/machines/local/model-token");
    expect(res!.status).toBe(400);
  });

  test("the machine itself (loopback owner, no device, no installation person) can mint: the setup script runs there", async () => {
    const ctxRoute = routerWith([{ id: "m1", baseUrl: "https://pc:3333" }], "loopback");
    const res = await ctxRoute("POST", "/api/machines/m1/model-token");
    expect(res!.status).toBe(200);
  });

  test("a non-owner is refused", async () => {
    const res = await routerWith([{ id: "m1", baseUrl: "https://pc:3333" }], false)("POST", "/api/machines/m1/model-token");
    expect(res!.status).toBe(403);
  });

  test("mints the plaintext once, the hash file never contains it, and DELETE revokes", async () => {
    const route = routerWith([{ id: "m1", baseUrl: "https://pc:3333" }]);
    const res = await route("POST", "/api/machines/m1/model-token");
    const { token } = await res!.json() as { token: string };
    expect(token).toStartWith("tmt_");
    expect(readFileSync(modelTokenPath(stateDir, "m1"), "utf8")).not.toContain(token);
    expect(machineForModelToken(stateDir, token)).toBe("m1");
    const del = await route("DELETE", "/api/machines/m1/model-token");
    expect(del!.status).toBe(200);
    expect(machineForModelToken(stateDir, token)).toBeNull();
  });

  test("deleting the machine row revokes its model token", async () => {
    const token = mintModelToken(stateDir, "m1");
    const res = await routerWith([{ id: "m1", baseUrl: "https://pc:3333" }])("DELETE", "/api/machines/m1");
    expect(res!.status).toBe(200);
    expect(machineForModelToken(stateDir, token)).toBeNull();
  });
});
