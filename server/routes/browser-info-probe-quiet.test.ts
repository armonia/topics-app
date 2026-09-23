/**
 * GET /api/browsers/:id on a context that does not exist is an ANSWER, not a
 * fault: `contextHasPage` asks it on purpose before seeding a pane, and the
 * fallback poll of `useRemoteBrowser` asks it every 2 s. Each 404 used to write
 * `[Warn 404] Browser context not found`: 4.502 lines in the last 5 MB of the
 * production error log of 23/09, the biggest single source there, burying the
 * warnings that mean something.
 * @covers BROWSER-CHAT-01
 */
import { describe, test, expect } from "bun:test";
import { createBrowserRouter } from "./browser";

function harness() {
  const logged: { status: number; message: string }[] = [];
  const service = {
    getUrl: (id: string) => (id === "live" ? { url: "https://example.com/", title: "Example" } : null),
    setEngineHint: () => {},
    listContexts: () => [],
  } as unknown as Parameters<typeof createBrowserRouter>[1];

  const ctx = {
    json: (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
    readJSON: async (req: Request) => { try { return await req.json(); } catch { return null; } },
    // Same contract as utils.ts:errorResponse: logs unless `log: false`.
    errorResponse: (status: number, message: string, options: { log?: boolean } = {}) => {
      if (options.log !== false) logged.push({ status, message });
      return new Response(JSON.stringify({ error: message }), { status });
    },
    matchRoute: (pathname: string, pattern: string): Record<string, string> | null => {
      const pp = pattern.split("/");
      const xp = pathname.split("/");
      if (pp.length !== xp.length) return null;
      const params: Record<string, string> = {};
      for (let i = 0; i < pp.length; i++) {
        if (pp[i].startsWith(":")) params[pp[i].slice(1)] = decodeURIComponent(xp[i]);
        else if (pp[i] !== xp[i]) return null;
      }
      return params;
    },
    broadcastToAll: () => {},
  } as unknown as Parameters<typeof createBrowserRouter>[0];

  const router = createBrowserRouter(ctx, service);
  const get = (id: string) => {
    const url = new URL(`http://x/api/browsers/${encodeURIComponent(id)}`);
    return router(new Request(url), url, url.pathname, "GET");
  };
  return { get, logged };
}

describe("GET /api/browsers/:id", () => {
  test("a missing context answers 404 without writing a warning", async () => {
    const { get, logged } = harness();
    const res = await get("gone");
    expect(res?.status).toBe(404);
    expect(await res!.json()).toEqual({ error: "Browser context not found" });
    expect(logged).toEqual([]);
  });

  test("a live context still answers with its url", async () => {
    const { get } = harness();
    const res = await get("live");
    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual({ url: "https://example.com/", title: "Example" });
  });
});
