/**
 * A restarted MCP server forgot our session: the client shakes hands again
 * instead of failing every call until Topics restarts.
 *
 * @covers MCPSRV-06
 */
import { afterEach, describe, expect, test } from "bun:test";
import { connectMcpServer } from "./mcp-client";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/**
 * A fake HTTP MCP server. `restart()` forgets every session, and a request that
 * carries an unknown one gets `stale` back, the way the MCP SDK answers.
 */
function fakeServer(stale: { status: number; body: unknown }) {
  let generation = 1;
  const sessions = new Set<string>();
  const log: string[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    const msg = JSON.parse(String(init?.body)) as { id?: number; method: string };
    const sid = headers["mcp-session-id"];
    log.push(`${msg.method}${sid ? `@${sid}` : ""}`);
    if (msg.method === "initialize") {
      const id = `s${generation}-${sessions.size + 1}`;
      sessions.add(id);
      return Response.json({ jsonrpc: "2.0", id: msg.id, result: { serverInfo: { name: "fake" }, capabilities: {} } }, { headers: { "mcp-session-id": id } });
    }
    if (msg.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (!sid || !sessions.has(sid)) return Response.json(stale.body, { status: stale.status });
    return Response.json({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "ok" }] } });
  }) as unknown as typeof fetch;
  return { log, restart: () => { generation++; sessions.clear(); } };
}

describe("HTTP MCP session after a server restart", () => {
  test('400 "Server not initialized": new handshake, the call succeeds', async () => {
    const server = fakeServer({ status: 400, body: { jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: Server not initialized" }, id: null } });
    const conn = await connectMcpServer("gateway", { type: "http", url: "http://127.0.0.1:1/mcp" });
    server.restart();
    const out = await conn.callTool("echo", {});
    expect(out.content).toBe("ok");
    expect(server.log).toEqual([
      "initialize", "notifications/initialized@s1-1",
      "tools/call@s1-1", "initialize", "notifications/initialized@s2-1", "tools/call@s2-1",
    ]);
  });

  test('404 "Session not found": the same', async () => {
    const server = fakeServer({ status: 404, body: { jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null } });
    const conn = await connectMcpServer("gateway", { type: "http", url: "http://127.0.0.1:1/mcp" });
    server.restart();
    expect((await conn.callTool("echo", {})).content).toBe("ok");
  });

  test("a 400 that is not about the session fails, with no new handshake", async () => {
    const server = fakeServer({ status: 400, body: { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null } });
    const conn = await connectMcpServer("gateway", { type: "http", url: "http://127.0.0.1:1/mcp" });
    server.restart();
    const error = await conn.callTool("echo", {}).then(() => null, (e: Error) => e);
    expect(error?.message).toContain("HTTP 400");
    expect(server.log.filter((l) => l === "initialize")).toHaveLength(1);
  });
});
