/**
 * The store behind `show_view` (GENUI-02): a POST from the bridge stores the
 * normalized view and answers its page path; a GET gives it back; a bad view
 * is a 400 that names the fields, which the agent reads as the tool's error.
 * And the bridge tool on top of it, wired to this very router.
 *
 * @covers GENUI-02
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createViewsRouter } from "./views";
import { callShowView } from "../mcp/view-tools";
import type { AppContext } from "../types";
import { sitgesCompare } from "../../tests/e2e/fixtures/sitges-compare";

const dir = mkdtempSync(join(tmpdir(), "views-route-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function matchRoute(pathname: string, pattern: string): Record<string, string> | null {
  const p = pattern.split("/");
  const s = pathname.split("/");
  if (p.length !== s.length) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(":")) out[p[i].slice(1)] = s[i];
    else if (p[i] !== s[i]) return null;
  }
  return out;
}

const ctx = {
  STATE_DIR: dir,
  json: (data: unknown, status = 200) => Response.json(data, { status }),
  matchRoute,
  getTopicBySessionKey: (key: string) => (key === "topic:64095902" ? { id: "64095902" } : null),
} as unknown as AppContext;

const router = createViewsRouter(ctx, { dir });
const call = (method: string, path: string, body?: unknown) =>
  router(
    new Request(`http://t${path}`, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) }),
    new URL(`http://t${path}`),
    path,
    method,
  );

describe("views router", () => {
  test("POST stores the normalized view, GET gives it back with its topic", async () => {
    const res = (await call("POST", "/api/sessions/topic%3A64095902/views", sitgesCompare("/i")))!;
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; path: string };
    expect(body.id).toMatch(/^[0-9a-f]{16}$/);
    expect(body.path).toBe(`/v/${body.id}`);
    expect(readdirSync(dir)).toContain(`${body.id}.json`);

    const got = (await call("GET", `/api/views/${body.id}`))!;
    expect(got.status).toBe(200);
    const view = (await got.json()) as { topicId: string; spec: { options: Array<{ title: string; recommended?: boolean }> } };
    expect(view.topicId).toBe("64095902");
    expect(view.spec.options.find((o) => o.recommended)?.title).toBe("Nautilus");
  });

  test("a bad view is a 400 that lists what to fix, and nothing is stored", async () => {
    const before = readdirSync(dir).length;
    const res = (await call("POST", "/api/sessions/topic%3Ax/views", { title: "T", options: [{ title: "only one" }] }))!;
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid view: 'options' must have 2-4 items (got 1)",
      errors: ["'options' must have 2-4 items (got 1)"],
    });
    expect(readdirSync(dir).length).toBe(before);
  });

  test("an id that is not ours is a 404, never a path outside the folder", async () => {
    expect((await call("GET", "/api/views/0000000000000000"))!.status).toBe(404);
    expect((await call("GET", "/api/views/..%2F..%2Fetc%2Fpasswd"))!.status).toBe(404);
    expect(await call("GET", "/api/other")).toBeNull();
    expect(await call("DELETE", "/api/views/0000000000000000")).toBeNull();
  });
});

describe("show_view bridge tool", () => {
  // The bridge's fetch, answered by the router above: the same request path,
  // method and body the real bridge sends to topics-app.
  const viaRouter = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const res = await router(new Request(url, init), url, url.pathname, init?.method ?? "GET");
    return res ?? new Response("not found", { status: 404 });
  }) as typeof fetch;
  const args = { baseUrl: "https://127.0.0.1:3333", sessionKey: "topic:64095902" };

  test("returns the page address, which the chat reads the view id from", async () => {
    const out = await callShowView(args, sitgesCompare("/i"), viaRouter);
    expect(out).toMatch(/^shown in chat · compare · 3 options · page https:\/\/127\.0\.0\.1:3333\/v\/[0-9a-f]{16}$/);
  });

  test("the route's 400 reaches the agent as the tool's error, field by field", async () => {
    await expect(callShowView(args, { title: "T", options: [{ title: "A", recommended: true }, { title: "B", recommended: true }] }, viaRouter))
      .rejects.toThrow("at most one option may be 'recommended' (got 2)");
  });
});
