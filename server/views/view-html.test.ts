/**
 * MCP Apps interop (GENUI-08): the views as `ui://` resources, through the
 * bridge's real `handleMessage`, answered by the real views router. And the
 * one rule a document drawn from a model's data must never break: text is
 * text, never markup.
 *
 * @covers GENUI-08
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createViewsRouter } from "../routes/views";
import { handleMessage } from "../mcp/topics-mcp-server";
import type { AppContext } from "../types";
import { normalizeViewSpec, type ViewSpec } from "../../shared/views";
import { doorToDoorTimeline, trainsTable } from "../../tests/e2e/fixtures/trip-views";
import { staysCompare } from "../../tests/e2e/fixtures/sitges-compare";
import { MCP_APP_MIME, VIEW_APP_URI, VIEW_META_KEY, renderViewDocument, renderViewFragment } from "./view-html";

const dir = mkdtempSync(join(tmpdir(), "views-mcp-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// A real local photo inside the allowlist, and one outside it.
const photo = join(dir, "cover.jpg");
writeFileSync(photo, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));

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
  getTopicBySessionKey: () => ({ id: "64095902" }),
  isPathAllowed: (p: string) => p === photo,
} as unknown as AppContext;
const router = createViewsRouter(ctx, { dir: join(dir, "views") });

// `handleMessage` uses the global fetch: point it at the router for these tests.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const res = await router(new Request(url, init), url, url.pathname, init?.method ?? "GET");
  return res ?? new Response("not found", { status: 404 });
}) as typeof fetch;
afterAll(() => { globalThis.fetch = realFetch; });

const args = { baseUrl: "https://127.0.0.1:3333", sessionKey: "topic:64095902" } as Parameters<typeof handleMessage>[1];
let seq = 0;
const rpc = async (method: string, params?: unknown) => {
  const r = await handleMessage({ jsonrpc: "2.0", id: ++seq, method, params } as Parameters<typeof handleMessage>[0], args);
  return r as unknown as { result?: Record<string, any>; error?: { code: number; message: string } };
};

const spec = (input: Record<string, unknown>): ViewSpec => {
  const r = normalizeViewSpec(input);
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.spec;
};

describe("show_view over MCP", () => {
  test("tools/list links the tool to the app resource; tools/call carries the drawn view in _meta, not in the text", async () => {
    const list = await rpc("tools/list");
    const tool = list.result!.tools.find((t: { name: string }) => t.name === "show_view");
    expect(tool._meta.ui.resourceUri).toBe(VIEW_APP_URI);

    const call = await rpc("tools/call", { name: "show_view", arguments: trainsTable() });
    const result = call.result!;
    expect(result.content[0].text).toMatch(/^shown in chat · table · 3 rows · page https:\/\/127\.0\.0\.1:3333\/v\/[0-9a-f]{16}$/);
    expect(result.structuredContent).toMatchObject({ view: "table" });
    const drawn = result._meta[VIEW_META_KEY] as { id: string; html: string };
    expect(drawn.id).toBe(result.structuredContent.id);
    expect(drawn.html).toContain("Huesca → Barcelona Sants");
    // Markup for the generic app to inject, not a second document inside its <main>.
    expect(drawn.html.startsWith('<div class="view"')).toBe(true);
    // The markup stays out of what the model reads.
    expect(result.content[0].text).not.toContain("<");
  });

  test("resources: the app, the template, a stored view by id, and a 'not found' for anything else", async () => {
    const call = await rpc("tools/call", { name: "show_view", arguments: doorToDoorTimeline() });
    const id = call.result!.structuredContent.id as string;

    const list = await rpc("resources/list");
    const uris = list.result!.resources.map((r: { uri: string }) => r.uri);
    expect(uris[0]).toBe(VIEW_APP_URI);
    expect(uris).toContain(`${VIEW_APP_URI}/${id}`);
    expect((await rpc("resources/templates/list")).result!.resourceTemplates[0].uriTemplate).toBe(`${VIEW_APP_URI}/{id}`);

    const app = (await rpc("resources/read", { uri: VIEW_APP_URI })).result!.contents[0];
    expect(app.mimeType).toBe(MCP_APP_MIME);
    expect(app.text).toContain('aria-busy="true"');
    expect(app.text).toContain("ui/initialize");

    const one = (await rpc("resources/read", { uri: `${VIEW_APP_URI}/${id}` })).result!.contents[0];
    expect(one.mimeType).toBe(MCP_APP_MIME);
    expect(one.text).toContain("Volo easyJet U24212 dal T2");
    expect(one.text).toContain('href="https://127.0.0.1:3333/v/' + id + '"');

    expect((await rpc("resources/read", { uri: `${VIEW_APP_URI}/../../etc` })).error!.code).toBe(-32002);
    expect((await rpc("resources/read", { uri: `${VIEW_APP_URI}/0000000000000000` })).error!.code).toBe(-32002);
  });

  test("photos: https stays a URL and its origin is declared for the host's CSP; an allowed local photo travels inline; others are dropped", async () => {
    const input = staysCompare("/i") as Record<string, any>;
    input.options[0].images = [{ src: "https://a0.muscache.com/im/x.jpg" }];
    input.options[1].images = [{ src: photo }];
    input.options[2].images = [{ src: "/etc/not-allowed.jpg" }];
    const call = await rpc("tools/call", { name: "show_view", arguments: input });
    const id = call.result!.structuredContent.id as string;
    const one = (await rpc("resources/read", { uri: `${VIEW_APP_URI}/${id}` })).result!.contents[0];
    expect(one._meta.ui.csp.resourceDomains).toEqual(["https://a0.muscache.com"]);
    expect(one.text).toContain('src="https://a0.muscache.com/im/x.jpg"');
    expect(one.text).toContain(`src="data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString("base64")}"`);
    expect(one.text).not.toContain("not-allowed");
  });
});

describe("the document", () => {
  test("a model's text is escaped everywhere it lands", () => {
    const evil = '<img src=x onerror="alert(1)">';
    const html = renderViewDocument(spec({
      view: "table", title: evil, verdict: evil, columns: [evil, "n"], rows: [{ cells: [evil, 1], note: evil }], footnote: evil,
    }));
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  test("each kind draws its marks: recommended row and best cell, deadline step, recommended card", () => {
    const table = renderViewFragment(spec(trainsTable()));
    expect(table).toContain('<tr class="rec">');
    expect((table.match(/class="best"/g) ?? []).length).toBe(2);
    const timeline = renderViewFragment(spec(doorToDoorTimeline()));
    expect(timeline).toContain('<li class="step deadline">');
    expect(timeline).toContain("Taxi dal T1 alla porta");
    expect(renderViewFragment(spec(staysCompare("/i")))).toContain('<article class="card rec">');
  });

  test("the words follow the language asked, Italian by default like the app", () => {
    const s = spec(doorToDoorTimeline());
    expect(renderViewFragment(s)).toContain("Verdetto");
    expect(renderViewFragment(s, { language: "en" })).toContain("Verdict");
  });
});
