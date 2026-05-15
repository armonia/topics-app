/**
 * Unit coverage for the topics-app MCP server (server/mcp/topics-mcp-server.ts).
 *
 * The module guards `main()` behind `import.meta.main` so importing it from
 * the test file does NOT spin up the stdio server. We exercise the exported
 * pure functions instead:
 *   - `parseArgs` — argv parsing + required-arg validation
 *   - `handleMessage` — JSON-RPC initialize / tools/list / tools/call wiring
 *   - `callOpenBrowserPane` — HTTP call shape (URL, headers, body)
 *
 * The HTTP layer is exercised via a tiny stub `fetch` so we don't have to
 * spin up the topics-app server. callOpenBrowserPane accepts the fetchImpl
 * as a parameter precisely to make this test possible.
 */
import { describe, test, expect } from "bun:test";
import {
  parseArgs,
  callOpenBrowserPane,
  handleMessage,
} from "./topics-mcp-server";

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  test("parses base-url + session-key", () => {
    const args = parseArgs([
      "--base-url=http://localhost:3333",
      "--session-key=topic:abcdef",
    ]);
    expect(args.baseUrl).toBe("http://localhost:3333");
    expect(args.sessionKey).toBe("topic:abcdef");
    expect(args.gatewayToken).toBeUndefined();
  });

  test("strips trailing slash from baseUrl", () => {
    const args = parseArgs([
      "--base-url=http://localhost:3333/",
      "--session-key=s",
    ]);
    expect(args.baseUrl).toBe("http://localhost:3333");
  });

  test("captures optional gateway-token", () => {
    const args = parseArgs([
      "--base-url=http://x",
      "--session-key=s",
      "--gateway-token=secret-123",
    ]);
    expect(args.gatewayToken).toBe("secret-123");
  });

  test("throws when --base-url missing", () => {
    expect(() => parseArgs(["--session-key=s"])).toThrow(/base-url is required/);
  });

  test("throws when --session-key missing", () => {
    expect(() => parseArgs(["--base-url=http://x"])).toThrow(/session-key is required/);
  });

  test("ignores unknown args", () => {
    const args = parseArgs([
      "--base-url=http://x",
      "--session-key=s",
      "--unknown-flag=ignored",
      "garbage",
    ]);
    expect(args.baseUrl).toBe("http://x");
    expect(args.sessionKey).toBe("s");
  });
});

// ---------------------------------------------------------------------------
// callOpenBrowserPane
// ---------------------------------------------------------------------------

function stubFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return impl as typeof fetch;
}

describe("callOpenBrowserPane", () => {
  test("POSTs to the session-keyed open-pane endpoint", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const fetchImpl = stubFetch(async (url, init) => {
      seen.url = String(url);
      seen.init = init;
      return new Response(
        JSON.stringify({ url: "https://example.com/final", title: "Example Domain" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await callOpenBrowserPane(
      { baseUrl: "http://localhost:3333", sessionKey: "topic:abc def" },
      { url: "https://example.com" },
      fetchImpl,
    );

    expect(seen.url).toBe(
      "http://localhost:3333/api/sessions/topic%3Aabc%20def/browser/open-pane",
    );
    expect(seen.init?.method).toBe("POST");
    const headers = seen.init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Gateway-Token"]).toBeUndefined();
    expect(seen.init?.body).toBe(JSON.stringify({ url: "https://example.com" }));
    expect(result).toEqual({ url: "https://example.com/final", title: "Example Domain" });
  });

  test("forwards gateway-token as X-Gateway-Token header", async () => {
    let seenHeader: string | undefined;
    const fetchImpl = stubFetch(async (_url, init) => {
      seenHeader = (init?.headers as Record<string, string>)?.["X-Gateway-Token"];
      return new Response(JSON.stringify({ url: "x", title: "" }), { status: 200 });
    });

    await callOpenBrowserPane(
      { baseUrl: "http://x", sessionKey: "s", gatewayToken: "tok-abc" },
      { url: "https://example.com" },
      fetchImpl,
    );

    expect(seenHeader).toBe("tok-abc");
  });

  test("throws on missing url argument", async () => {
    const fetchImpl = stubFetch(async () => new Response("", { status: 200 }));
    await expect(
      callOpenBrowserPane(
        { baseUrl: "http://x", sessionKey: "s" },
        {},
        fetchImpl,
      ),
    ).rejects.toThrow(/url.*required/i);
  });

  test("throws on non-2xx response with server message", async () => {
    const fetchImpl = stubFetch(async () =>
      new Response("Topic not found", { status: 404, statusText: "Not Found" }),
    );
    await expect(
      callOpenBrowserPane(
        { baseUrl: "http://x", sessionKey: "s" },
        { url: "https://example.com" },
        fetchImpl,
      ),
    ).rejects.toThrow(/HTTP 404.*Topic not found/);
  });

  test("falls back to input url + empty title when server omits fields", async () => {
    const fetchImpl = stubFetch(async () =>
      new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const result = await callOpenBrowserPane(
      { baseUrl: "http://x", sessionKey: "s" },
      { url: "https://example.com/foo" },
      fetchImpl,
    );
    expect(result).toEqual({ url: "https://example.com/foo", title: "" });
  });

  test("surfaces server-side { error } as throw", async () => {
    const fetchImpl = stubFetch(async () =>
      new Response(JSON.stringify({ error: "Browser service disabled" }), { status: 200 }),
    );
    await expect(
      callOpenBrowserPane(
        { baseUrl: "http://x", sessionKey: "s" },
        { url: "https://example.com" },
        fetchImpl,
      ),
    ).rejects.toThrow(/Browser service disabled/);
  });
});

// ---------------------------------------------------------------------------
// handleMessage — JSON-RPC routing
// ---------------------------------------------------------------------------

const ARGS = { baseUrl: "http://localhost:3333", sessionKey: "s" };

describe("handleMessage", () => {
  test("initialize → returns protocolVersion + tools capability", async () => {
    const resp = await handleMessage(
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      ARGS,
    );
    expect(resp).not.toBeNull();
    expect(resp!.id).toBe(1);
    const result = resp!.result as any;
    expect(result.protocolVersion).toBe("2024-11-05");
    expect(result.capabilities).toEqual({ tools: {} });
    expect(result.serverInfo.name).toBe("topics-app");
  });

  test("tools/list → returns open_browser_pane schema", async () => {
    const resp = await handleMessage(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      ARGS,
    );
    const tools = (resp!.result as any).tools as Array<{ name: string; inputSchema: any }>;
    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe("open_browser_pane");
    expect(tools[0].inputSchema.required).toEqual(["url"]);
    expect(tools[0].inputSchema.properties.url.type).toBe("string");
  });

  test("tools/call with unknown name → -32601 error", async () => {
    const resp = await handleMessage(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "nope", arguments: {} } },
      ARGS,
    );
    expect(resp!.error).toEqual({ code: -32601, message: "Unknown tool: nope" });
  });

  test("unknown method → -32601 Method not found", async () => {
    const resp = await handleMessage(
      { jsonrpc: "2.0", id: 4, method: "completely/made-up" },
      ARGS,
    );
    expect(resp!.error?.code).toBe(-32601);
    expect(resp!.error?.message).toContain("Method not found");
  });

  test("notification (notifications/initialized) → null response", async () => {
    const resp = await handleMessage(
      { jsonrpc: "2.0", id: null, method: "notifications/initialized" },
      ARGS,
    );
    expect(resp).toBeNull();
  });
});
