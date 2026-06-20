/**
 * End-to-end coverage of the ACTUAL MCP stdio server process.
 *
 * The other suite exercises exported functions; this one spawns
 * `topics-mcp-server.ts` as a real subprocess and speaks JSON-RPC 2.0 over its
 * stdin/stdout, exactly as the Claude Code CLI does. A tiny local HTTP server
 * stands in for topics-app (passed as --base-url) so tools/call round-trips for
 * real. This verifies the readline loop, stdout framing, the registry dispatch,
 * and the httpJson layer together — the parts unit tests can't reach.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { join } from "path";

const SERVER_SCRIPT = join(import.meta.dir, "topics-mcp-server.ts");

// ── Mock topics-app HTTP server ────────────────────────────────────────────
let httpServer: ReturnType<typeof Bun.serve>;
let baseUrl = "";
const seenRequests: Array<{ method: string; path: string; body: any }> = [];

beforeAll(() => {
  httpServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      let body: any = null;
      try { body = await req.json(); } catch {}
      seenRequests.push({ method: req.method, path: u.pathname, body });

      if (u.pathname.endsWith("/scripts/run")) {
        return Response.json({ processId: "e2e-1", scriptName: "test", pid: 1234, startedAt: "now" });
      }
      if (u.pathname.endsWith("/scripts")) {
        return Response.json({ scripts: [{ status: "running", scriptName: "dev", processId: "e2e-1", pid: 10, ports: [5173] }] });
      }
      return Response.json({ ok: true });
    },
  });
  baseUrl = `http://localhost:${httpServer.port}`;
});

afterAll(() => { try { httpServer.stop(true); } catch {} });

// ── JSON-RPC-over-stdio driver ─────────────────────────────────────────────
function makeClient() {
  const proc = Bun.spawn(["bun", "run", SERVER_SCRIPT, `--base-url=${baseUrl}`, "--session-key=s"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const pending = new Map<number, (msg: any) => void>();
  let buf = "";

  (async () => {
    const reader = proc.stdout.getReader();
    const dec = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id != null && pending.has(msg.id)) {
            pending.get(msg.id)!(msg);
            pending.delete(msg.id);
          }
        } catch { /* ignore non-JSON */ }
      }
    }
  })();

  function request(id: number, method: string, params?: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for id=${id} (${method})`)), 5000);
      pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) + "\n");
      proc.stdin.flush();
    });
  }

  async function close() {
    try { proc.stdin.end(); } catch {}
    await proc.exited;
  }

  return { request, close };
}

describe("MCP stdio server (subprocess)", () => {
  let client: ReturnType<typeof makeClient>;
  beforeAll(() => { client = makeClient(); });
  afterAll(async () => { await client.close(); });

  test("initialize handshake", async () => {
    const resp = await client.request(1, "initialize");
    expect(resp.result.protocolVersion).toBe("2024-11-05");
    expect(resp.result.serverInfo.name).toBe("topics-app");
  });

  test("tools/list returns all tools", async () => {
    const resp = await client.request(2, "tools/list");
    const names = resp.result.tools.map((t: any) => t.name);
    expect(names).toEqual([
      "open_browser_pane", "import_chrome", "run_script", "list_processes",
      "read_process_output", "stop_process", "list_tasks", "update_task",
    ]);
  });

  test("tools/call list_processes round-trips to the session endpoint", async () => {
    const resp = await client.request(3, "tools/call", { name: "list_processes", arguments: {} });
    expect(resp.result.isError).toBeUndefined();
    expect(resp.result.content[0].text).toContain("[running] dev id=e2e-1");
    expect(seenRequests.some(r => r.method === "GET" && r.path === "/api/sessions/s/scripts")).toBe(true);
  });

  test("tools/call run_script POSTs scriptName to the session endpoint", async () => {
    const resp = await client.request(4, "tools/call", { name: "run_script", arguments: { script: "test" } });
    expect(resp.result.content[0].text).toContain("processId=e2e-1");
    const hit = seenRequests.find(r => r.method === "POST" && r.path === "/api/sessions/s/scripts/run");
    expect(hit?.body).toEqual({ scriptName: "test" });
  });

  test("tools/call unknown tool → JSON-RPC error", async () => {
    const resp = await client.request(5, "tools/call", { name: "does_not_exist", arguments: {} });
    expect(resp.error.code).toBe(-32601);
    expect(resp.error.message).toContain("Unknown tool");
  });
});
