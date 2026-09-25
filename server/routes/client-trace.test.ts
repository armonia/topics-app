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

  it("caps what one event can put in the log", () => {
    const lines = formatClientTraceLines({ events: [{ at: AT, event: "e".repeat(500), fields: { big: "f".repeat(5000) } }] }, null);
    expect(lines![0].length).toBeLessThan(900);
    expect(lines![0]).toContain("pane-attach " + "e".repeat(80) + "…");
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

  it("leaves every other path to the next router", async () => {
    const router = createClientTraceRouter(ctx, () => {});
    expect(await router(post({}), new URL("http://x/api/other"), "/api/other", "POST")).toBeNull();
  });
});
