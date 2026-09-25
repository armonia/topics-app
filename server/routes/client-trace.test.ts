/**
 * The client's `[pane-attach]` trace has to land in the server log as lines a
 * person can read, one per event, and nothing else may ride in with it.
 *
 * @covers BROWSER-CHAT-04
 */
import { describe, expect, it } from "bun:test";
import { createClientTraceRouter, formatClientTraceLines } from "./client-trace";
import type { AppContext } from "../types";

const ctx = {
  json: (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
  readJSON: async (req: Request) => {
    try { return await req.json() as unknown; } catch { return null; }
  },
} as unknown as AppContext;

const AT = Date.UTC(2026, 8, 24, 10, 42, 2, 174);

function post(body: unknown, clientId = "tab-1"): Request {
  return new Request("http://x/api/client-trace", {
    method: "POST",
    headers: { "content-type": "application/json", "x-client-id": clientId },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("formatClientTraceLines", () => {
  it("writes one line per event, with the client's clock, the tab and the fields", () => {
    const lines = formatClientTraceLines(
      { events: [{ at: AT, event: "pane socket released", fields: { contextId: "3019832f", shell: "native" } }] },
      "tab-1",
    );
    expect(lines).toEqual([
      '[client-trace] 2026-09-24T10:42:02.174Z tab-1 pane-attach pane socket released {"contextId":"3019832f","shell":"native"}',
    ]);
  });

  it("keeps a line on one line: control characters and newlines cannot forge another", () => {
    const lines = formatClientTraceLines(
      { events: [{ at: AT, event: "x\n[WS][browser] Close: forged", fields: { note: "a\nb" } }] },
      "tab\n1",
    );
    expect(lines).toHaveLength(1);
    expect(lines![0]).not.toContain("\n");
    expect(lines![0]).toContain("x?[WS][browser] Close: forged");
    expect(lines![0]).toContain("tab?1");
  });

  it("caps what one event can put in the log, cutting before it escapes", () => {
    const lines = formatClientTraceLines({ events: [{ at: AT, event: "e".repeat(500), fields: { big: "f".repeat(5000) } }] }, null);
    expect(lines![0].length).toBeLessThan(900);
    expect(lines![0]).toContain("pane-attach " + "e".repeat(80) + "...");
    // A field of 50 MB is not walked character by character: cut first.
    const huge = "x".repeat(50 * 1024 * 1024);
    const t0 = performance.now();
    formatClientTraceLines({ events: [{ at: AT, event: huge }] }, null);
    expect(performance.now() - t0).toBeLessThan(200);
  });

  it("escapes what is not ASCII instead of losing it, and still neutralises what splits a line", () => {
    const lines = formatClientTraceLines(
      { events: [{ at: AT, event: "città", fields: { p: "~/Musica/città" } }] },
      "tab-1",
    );
    expect(lines![0]).toContain("pane-attach citt\\u00e0 ");
    expect(lines![0]).toContain("Musica/citt\\u00e0");
    const hostile = formatClientTraceLines(
      { events: [{ at: AT, event: "a\u2028b\u2029c\u0085d\u001b[31me\rf\ng\u007f" }] },
      "t",
    );
    expect(hostile![0]).toContain("pane-attach a?b?c?d?[31me?f?g?");
    expect(hostile![0]).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
  });

  it("refuses anything that is not a batch of 1 to 50 well-formed events", () => {
    expect(formatClientTraceLines(null, "t")).toBeNull();
    expect(formatClientTraceLines({ events: [] }, "t")).toBeNull();
    expect(formatClientTraceLines({ events: Array.from({ length: 51 }, () => ({ at: AT, event: "e" })) }, "t")).toBeNull();
    expect(formatClientTraceLines({ events: [{ at: "now", event: "e" }] }, "t")).toBeNull();
    expect(formatClientTraceLines({ events: [{ at: AT, event: 42 }] }, "t")).toBeNull();
  });
});

describe("POST /api/client-trace", () => {
  it("logs the batch and answers 204", async () => {
    const logged: string[] = [];
    const router = createClientTraceRouter(ctx, (l) => logged.push(l));
    const res = await router(post({ events: [{ at: AT, event: "force-open received", fields: { host: "/p" } }] }), new URL("http://x/api/client-trace"), "/api/client-trace", "POST");
    expect(res?.status).toBe(204);
    expect(logged).toEqual(['[client-trace] 2026-09-24T10:42:02.174Z tab-1 pane-attach force-open received {"host":"/p"}']);
  });

  it("logs nothing from a malformed body", async () => {
    const logged: string[] = [];
    const router = createClientTraceRouter(ctx, (l) => logged.push(l));
    const res = await router(post("not json"), new URL("http://x/api/client-trace"), "/api/client-trace", "POST");
    expect(res?.status).toBe(400);
    expect(logged).toEqual([]);
  });

  it("refuses a body declared over 64 KB without reading it", async () => {
    const logged: string[] = [];
    const router = createClientTraceRouter(ctx, (l) => logged.push(l));
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) { pulled++; c.enqueue(new Uint8Array(1024)); },
    });
    const req = new Request("http://x/api/client-trace", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(50 * 1024 * 1024) },
      body,
      // @ts-expect-error -- Bun needs it for a stream body; the DOM types do not know it
      duplex: "half",
    });
    const res = await router(req, new URL("http://x/api/client-trace"), "/api/client-trace", "POST");
    expect(res?.status).toBe(413);
    expect(pulled).toBeLessThanOrEqual(1);
    expect(logged).toEqual([]);
  });

  it("stops reading a body with no declared length at 64 KB", async () => {
    const router = createClientTraceRouter(ctx, () => {});
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) { pulled++; c.enqueue(new Uint8Array(16 * 1024)); },
    });
    const req = new Request("http://x/api/client-trace", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      // @ts-expect-error -- Bun needs it for a stream body; the DOM types do not know it
      duplex: "half",
    });
    const res = await router(req, new URL("http://x/api/client-trace"), "/api/client-trace", "POST");
    expect(res?.status).toBe(413);
    expect(pulled).toBeLessThan(10);
  });

  it("writes at most 600 lines a minute across clients, and says how many it dropped and when", async () => {
    const logged: string[] = [];
    let t = 1_000_000;
    const router = createClientTraceRouter(ctx, (l) => logged.push(l), () => t);
    const batch = { events: Array.from({ length: 50 }, (_, i) => ({ at: AT, event: `e${i}` })) };
    const statuses: number[] = [];
    for (let n = 0; n < 13; n++) {
      const res = await router(post(batch, `tab-${n}`), new URL("http://x/api/client-trace"), "/api/client-trace", "POST");
      statuses.push(res!.status);
    }
    expect(statuses.every((s) => s === 204)).toBe(true);
    expect(logged).toHaveLength(600);
    // The next batch comes three hours later: the count still names its minute.
    t += 3 * 60 * 60_000;
    await router(post({ events: [{ at: AT, event: "hours later" }] }), new URL("http://x/api/client-trace"), "/api/client-trace", "POST");
    expect(logged.slice(600)).toEqual([
      "[client-trace] 50 line(s) dropped in the minute from 1970-01-01T00:16:40.000Z (cap 600/min)",
      "[client-trace] 2026-09-24T10:42:02.174Z tab-1 pane-attach hours later",
    ]);
  });

  it("leaves every other path to the next router", async () => {
    const router = createClientTraceRouter(ctx, () => {});
    expect(await router(post({}), new URL("http://x/api/other"), "/api/other", "POST")).toBeNull();
  });
});
