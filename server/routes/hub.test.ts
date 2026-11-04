/**
 * The bridge to the usage hub and to switchboard forwards to the configured
 * host only, never lets a failure read as data, and never forwards the
 * client's identity headers. The upstream is a real Bun server on a random
 * port: nothing reaches :3360 or :3335.
 * @covers HUBBR-01
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHubRouter, safeRest, upstreamBase } from "./hub";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

type Seen = { method: string; path: string; search: string; headers: Record<string, string>; body: string };
const seen: Seen[] = [];
let upstream: ReturnType<typeof Bun.serve>;
let base = "";

beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      seen.push({
        method: req.method, path: u.pathname, search: u.search,
        headers: Object.fromEntries(req.headers), body: await req.text(),
      });
      if (u.pathname === "/api/redirect") return new Response(null, { status: 302, headers: { location: "http://elsewhere/" } });
      if (u.pathname === "/api/broken") return json({ error: "boom" }, 500);
      if (u.pathname === "/api/slow") { await Bun.sleep(300); return json({ late: true }); }
      return json({ ok: true, path: u.pathname });
    },
  });
  base = `http://127.0.0.1:${upstream.port}`;
});
afterAll(() => upstream.stop(true));

function router(opts: { hub?: string | null; sw?: string | null; timeout?: number; live?: { snapshot(): Promise<unknown> } } = {}) {
  const r = createHubRouter({ json } as never, {
    hubBase: () => (opts.hub === undefined ? base : opts.hub),
    switchboardBase: () => (opts.sw === undefined ? base : opts.sw),
    headersTimeoutMs: opts.timeout,
    live: opts.live,
  });
  return async (method: string, path: string, init: RequestInit = {}) => {
    const url = new URL(`http://topics${path}`);
    return r(new Request(url, { method, ...init }), url, url.pathname, method);
  };
}

describe("HUBBR-01: /api/hub and /api/switchboard proxy", () => {
  test("maps /api/hub/<rest> to the hub's /api/<rest>, query included", async () => {
    seen.length = 0;
    const resp = (await router()("GET", "/api/hub/route?task=x&project=topics"))!;
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true, path: "/api/route" });
    expect(seen[0]).toMatchObject({ method: "GET", path: "/api/route", search: "?task=x&project=topics" });
    expect(resp.headers.get("cache-control")).toBe("no-store");
  });

  test("maps /api/switchboard/<rest> to switchboard's /api/<rest>", async () => {
    seen.length = 0;
    const resp = (await router({ hub: "http://127.0.0.1:1" })("GET", "/api/switchboard/profiles"))!;
    expect(resp.status).toBe(200);
    expect(seen[0]!.path).toBe("/api/profiles");
  });

  test("forwards a POST body and content-type, but not Origin, Cookie or Authorization", async () => {
    seen.length = 0;
    const resp = (await router()("POST", "/api/hub/attesa", {
      body: JSON.stringify({ tipo: "vista", title: "t" }),
      headers: { "content-type": "application/json", origin: "http://phone.local", cookie: "s=1", authorization: "Bearer x" },
    }))!;
    expect(resp.status).toBe(200);
    expect(seen[0]!.method).toBe("POST");
    expect(JSON.parse(seen[0]!.body)).toEqual({ tipo: "vista", title: "t" });
    expect(seen[0]!.headers["content-type"]).toBe("application/json");
    expect(seen[0]!.headers.origin).toBeUndefined();
    expect(seen[0]!.headers.cookie).toBeUndefined();
    expect(seen[0]!.headers.authorization).toBeUndefined();
  });

  test("passes an upstream error status through unchanged", async () => {
    const resp = (await router()("GET", "/api/hub/broken"))!;
    expect(resp.status).toBe(500);
    expect(await resp.json()).toEqual({ error: "boom" });
  });

  test("an unreachable hub is a 502 with the reason, never an empty 200", async () => {
    const resp = (await router({ hub: "http://127.0.0.1:1" })("GET", "/api/hub/pace"))!;
    expect(resp.status).toBe(502);
    const body = await resp.json();
    expect(body.upstream).toBe("hub");
    expect(body.error).toContain("not reachable");
  });

  test("a hub slower than the headers timeout is a 504", async () => {
    const resp = (await router({ timeout: 50 })("GET", "/api/hub/slow"))!;
    expect(resp.status).toBe(504);
  });

  test("a redirect is reported, not followed and not handed to the browser", async () => {
    const resp = (await router()("GET", "/api/hub/redirect"))!;
    expect(resp.status).toBe(502);
    expect(resp.headers.get("location")).toBeNull();
  });

  test("paths that could change the destination are refused before any request", async () => {
    seen.length = 0;
    const r = router();
    // `new URL` already folds plain `..` and `.`; what survives it is encoded.
    for (const p of ["/api/hub/..%2F..%2Fetc", "/api/hub//evil.example/x", "/api/hub/a%40b"]) {
      const resp = (await r("GET", p))!;
      expect(resp.status).toBe(400);
    }
    expect(seen.length).toBe(0);
    // A folded `..` that climbs out of /api/hub/ is no longer a hub path at all.
    expect(await r("GET", "/api/hub/../topics")).toBeNull();
    expect(await r("GET", "/api/hub/%2e%2e/x")).toBeNull();
  });

  test("no configured base (e2e) is a 503, and the hub is never called", async () => {
    seen.length = 0;
    const resp = (await router({ hub: null })("GET", "/api/hub/pace"))!;
    expect(resp.status).toBe(503);
    expect(seen.length).toBe(0);
  });

  test("other paths fall through to the next router", async () => {
    expect(await router()("GET", "/api/hubx/pace")).toBeNull();
    expect(await router()("GET", "/api/topics")).toBeNull();
  });

  test("GET /api/hub-live answers the live reader's snapshot", async () => {
    const snap = { pace: { data: [1], at: 5 } };
    const resp = (await router({ live: { snapshot: async () => snap } })("GET", "/api/hub-live"))!;
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual(snap);
    expect(((await router()("GET", "/api/hub-live"))!).status).toBe(503);
  });

  test("safeRest and upstreamBase", () => {
    expect(safeRest("")).toBe("");
    expect(safeRest("automations/runs")).toBe("automations/runs");
    expect(safeRest("a/../b")).toBeNull();
    expect(safeRest("a//b")).toBeNull();
    expect(safeRest("/evil.example/x")).toBeNull();
    expect(upstreamBase("X", "http://d", {})).toBe("http://d");
    expect(upstreamBase("X", "http://d", { X: "http://e/" })).toBe("http://e");
    expect(upstreamBase("X", "http://d", { TOPICS_E2E: "1" })).toBeNull();
    expect(upstreamBase("X", "http://d", { TOPICS_E2E: "1", X: "http://e" })).toBe("http://e");
  });
});
