import { describe, test, expect } from "bun:test";
import { createBrowserRouter } from "./browser";
import { evaluateAuth } from "../lib/auth-gate";
import { routedResourceUrl } from "../lib/dom-resource-rewrite";

function makeHarness() {
  const probes: string[] = [];
  const fetches: string[] = [];
  const ctx = {
    json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
    readJSON: async (req: Request) => req.json(),
    errorResponse: (status: number, message: string) => new Response(JSON.stringify({ error: message }), { status }),
    matchRoute: () => null,
  } as unknown as Parameters<typeof createBrowserRouter>[0];
  const service = {
    fetchResource: async (_id: string, _target: string) => { fetches.push(_target); return null; },
    screenshot: async () => Buffer.from([]),
    navigate: async () => {},
    destroyContext: async () => {},
  } as unknown as Parameters<typeof createBrowserRouter>[1];
  const router = createBrowserRouter(ctx, service, undefined, undefined, async (target) => {
    probes.push(target);
    return true;
  });
  const request = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const url = new URL(`http://localhost${path}`);
    const req = new Request(url, {
      method,
      headers: { Host: "localhost", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const auth = evaluateAuth({
      origin: req.headers.get("origin"), method, pathname: url.pathname,
      host: req.headers.get("host"), authOff: false,
    });
    if (!auth.allow) return new Response(null, { status: auth.status });
    return router(req, url, url.pathname, method);
  };
  return { probes, fetches, request };
}

describe("browser routes with server effects", () => {
  test("framing probe is origin-gated and accepts same-origin JSON POST", async () => {
    const { request, probes } = makeHarness();
    const denied = await request("POST", "/api/browsers/framable", { url: "http://127.0.0.1" }, {
      Origin: "https://example.com", "Content-Type": "application/json",
    });
    expect(denied?.status).toBe(403);
    expect(probes).toEqual([]);
    const response = await request("POST", "/api/browsers/framable", { url: "http://127.0.0.1" }, {
      Origin: "http://localhost", "Content-Type": "application/json",
    });
    expect(response?.status).toBe(200);
    expect(probes).toEqual(["http://127.0.0.1"]);
  });

  test("framing probe does not run for GET", async () => {
    const { request, probes } = makeHarness();
    const response = await request("GET", "/api/browsers/framable?url=http%3A%2F%2F127.0.0.1");
    expect(response?.status).toBe(405);
    expect(probes).toEqual([]);
  });

  test("framing probe requires JSON content type", async () => {
    const { request, probes } = makeHarness();
    const response = await request("POST", "/api/browsers/framable", { url: "http://127.0.0.1" }, {
      Origin: "http://localhost", "Content-Type": "text/plain",
    });
    expect(response?.status).toBe(415);
    expect(probes).toEqual([]);
  });

  test("an unopened context returns 404 without an upstream request", async () => {
    const { request, fetches } = makeHarness();
    const response = await request("GET", "/api/browser/resource?ctx=unopened&u=http%3A%2F%2F127.0.0.1%2Fimage.png");
    expect(response?.status).toBe(404);
    expect(fetches).toEqual([]);
  });

  test("resource requests without the context token do not call the service", async () => {
    const { request, fetches } = makeHarness();
    const response = await request("GET", "/api/browser/resource?ctx=task-12345678-0&u=http%3A%2F%2F127.0.0.1%2Fimage.png");
    expect(response?.status).toBe(404);
    expect(fetches).toEqual([]);
  });

  test("a resource request with its own context token reaches the service", async () => {
    const { request, fetches } = makeHarness();
    const resource = new URL(routedResourceUrl("context-a", "http://127.0.0.1/image.png")!, "http://localhost");
    await request("GET", `${resource.pathname}${resource.search}`);
    expect(fetches).toEqual(["http://127.0.0.1/image.png"]);
  });

  test("a resource token from one context is not valid for another", async () => {
    const { request, fetches } = makeHarness();
    const resource = new URL(routedResourceUrl("context-a", "http://127.0.0.1/image.png")!, "http://localhost");
    resource.searchParams.set("ctx", "context-b");
    const response = await request("GET", `${resource.pathname}${resource.search}`);
    expect(response?.status).toBe(404);
    expect(fetches).toEqual([]);
  });

});
