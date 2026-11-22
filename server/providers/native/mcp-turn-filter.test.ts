/**
 * @covers AGENTS-TOOLS-01
 *
 * The catalog's filter means nothing unless the TURN itself only sees the
 * allowed tools. `buildAgentToolsInventory({ agentId })` already narrowed what
 * the Sistema page shows; this proves the native provider's own turn (the
 * thing that actually talks to the model) narrows the same way, by driving
 * the real `NativeProvider` against a stubbed Anthropic endpoint and a fake
 * MCP fleet, and reading what tools it put on the wire.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NativeProvider } from "./provider";
import { closeMcpFleet } from "./mcp-fleet";
import type { StreamHandler } from "../types";

const PROTOCOL = "2024-11-05";

/** A minimal MCP server over Streamable HTTP, answering ONE named tool. */
function startFakeMcpServer(toolName: string) {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const msg = (await req.json()) as { id?: number; method: string };
      if (msg.id === undefined) return new Response(null, { status: 202 });
      const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: msg.id, result });
      switch (msg.method) {
        case "initialize":
          return reply({ protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: toolName, version: "0.0.1" } });
        case "tools/list":
          return reply({ tools: [{ name: toolName, description: "d", inputSchema: { type: "object", properties: {} } }] });
        default:
          return Response.json({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no" } });
      }
    },
  });
}

const answer = [
  { type: "message_start", message: { usage: { input_tokens: 10 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
].map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

const quiet: StreamHandler = { onTextDelta: () => {}, onToolStart: () => {}, onToolResult: () => {}, onDone: () => {}, onError: () => {} };

const REAL_HOME = process.env.HOME;
const realFetch = globalThis.fetch;
const envBackup: Record<string, string | undefined> = {};
let home: string;
let agentWorkspace: string;
let keptServer: ReturnType<typeof startFakeMcpServer>;
let droppedServer: ReturnType<typeof startFakeMcpServer>;

/**
 * Every MCP tool name the provider put on the wire for a turn sent in this
 * workspace. Only the Anthropic endpoint is stubbed: the fleet's own fetch
 * calls to the fake MCP servers above must go through for real, or mounting
 * never happens and the test would pass for the wrong reason (nothing to filter).
 */
async function mcpToolNamesSent(workspace: string): Promise<string[]> {
  let names: string[] = [];
  globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
    const target = typeof url === "string" ? url : (url as Request | URL).toString();
    if (!target.endsWith("/v1/messages")) return realFetch(url as never, init as never);
    const body = JSON.parse(String(init?.body ?? "{}")) as { tools?: Array<{ name: string }> };
    names = (body.tools ?? []).map((t) => t.name).filter((n) => n.startsWith("mcp__"));
    return new Response(answer, { status: 200 });
  }) as unknown as typeof fetch;
  const provider = new NativeProvider({ type: "native", defaultWorkspace: workspace, model: "claude-haiku-4-5-20251001" });
  await provider.sendChat(`topic:mcp-filter-${workspace}`, "ciao", quiet);
  return names;
}

beforeAll(() => {
  for (const k of ["TOPICS_MCP_CONFIG_FILE", "TOPICS_NATIVE_MCP", "TOPICS_SESSION_MCP_ALLOW", "TOPICS_SESSION_MCP_DENY", "TOPICS_SESSION_MCP_INHERIT_ALL", "JARVIS_CHANNELS_HOME", "APP_DATA_DIR"]) {
    envBackup[k] = process.env[k];
    delete process.env[k];
  }
  keptServer = startFakeMcpServer("keep_tool");
  droppedServer = startFakeMcpServer("drop_tool");

  home = mkdtempSync(join(tmpdir(), "native-mcp-filter-home-"));
  agentWorkspace = mkdtempSync(join(tmpdir(), "native-mcp-filter-agent-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "fake-but-fresh", refreshToken: "r", expiresAt: Date.now() + 3_600_000 } }),
  );
  process.env.HOME = home;

  const engineHome = join(home, "jarvis-channels");
  mkdirSync(engineHome, { recursive: true });
  writeFileSync(join(engineHome, "engine.json"), JSON.stringify({ agents: { jarvis: { workspace: agentWorkspace } } }));
  process.env.JARVIS_CHANNELS_HOME = engineHome;

  // `tests/setup/bun-test-preload.ts` pins `TOPICS_HOME` to an isolated
  // per-run folder regardless of `HOME`, so the settings file must follow
  // `resolveAppDataDir()`'s real answer (`APP_DATA_DIR` wins over it), not an
  // assumed `~/.topics`.
  const appDataDir = join(home, ".topics");
  process.env.APP_DATA_DIR = appDataDir;
  mkdirSync(appDataDir, { recursive: true });
  writeFileSync(
    join(appDataDir, "agent-tools.json"),
    JSON.stringify({ extraMcpFiles: [], extraSkillDirs: [], parkedMcp: [], agentFilters: { jarvis: { mode: "selected", servers: ["kept"] } } }),
  );

  process.env.TOPICS_MCP_CONFIG_FILE = join(home, "mcp.json");
  writeFileSync(
    process.env.TOPICS_MCP_CONFIG_FILE,
    JSON.stringify({ mcpServers: { kept: { type: "http", url: keptServer.url.href }, dropped: { type: "http", url: droppedServer.url.href } } }),
  );
});

afterAll(() => {
  closeMcpFleet();
  keptServer.stop(true);
  droppedServer.stop(true);
  globalThis.fetch = realFetch;
  if (REAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = REAL_HOME;
  for (const [k, v] of Object.entries(envBackup)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  for (const d of [home, agentWorkspace]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* scratch */ } }
});

describe("a turn only ever receives what the owning agent's filter allows", () => {
  test("THE BARRA: a topic whose workspace IS a filtered agent's folder gets only that agent's kept server", async () => {
    const names = await mcpToolNamesSent(agentWorkspace);
    // A turn that ignored the filter would send both: this is the line a
    // mutation on the filtering call in provider.ts turns red.
    expect(names).toEqual(["mcp__kept__keep_tool"]);
  });

  test("an ordinary topic, not any agent's own folder, still gets the whole fleet", async () => {
    const otherWorkspace = mkdtempSync(join(tmpdir(), "native-mcp-filter-other-"));
    try {
      const names = await mcpToolNamesSent(otherWorkspace);
      expect(names.sort()).toEqual(["mcp__dropped__drop_tool", "mcp__kept__keep_tool"]);
    } finally {
      rmSync(otherWorkspace, { recursive: true, force: true });
    }
  });
});
