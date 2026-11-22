/** @covers CODEX-01 MP-AGENTAUTH-01 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import net from "net";
import { closeDatabase, getDatabase, initDatabase } from "../db";
import { insertSubagent, markSubagentRemote } from "../lib/subagent-store";
import { createTerminalRouter, disconnectBridge } from "./terminal";
import { _setPtyBridgeSocketPath } from "./terminal-bridge-socket";
import type { AppContext } from "../types";

const originalTopicsHome = process.env.TOPICS_HOME;
const AGENT_TOKEN = "f".repeat(64);
let topicsHome: string | null = null;
const originalStandalone = process.env.TOPICS_DISABLE_PTY_BRIDGE;

afterEach(() => {
  if (originalTopicsHome === undefined) delete process.env.TOPICS_HOME;
  else process.env.TOPICS_HOME = originalTopicsHome;
  if (topicsHome) rmSync(topicsHome, { recursive: true, force: true });
  topicsHome = null;
  // Closing the fake bridge schedules its ordinary reconnect. Make that inert
  // before disconnecting so this test can never start a real bridge later.
  process.env.TOPICS_DISABLE_PTY_BRIDGE = "1";
  disconnectBridge();
  if (originalStandalone === undefined) delete process.env.TOPICS_DISABLE_PTY_BRIDGE;
  else process.env.TOPICS_DISABLE_PTY_BRIDGE = originalStandalone;
  _setPtyBridgeSocketPath(null);
});

test("Codex bridge-only HTTP spawn is refused before a Claude PTY create frame", async () => {
  // macOS Unix sockets cap path length well below the temp directory's full
  // `/var/folders/...` expansion, so keep the test socket directly under /tmp.
  const socketPath = `/tmp/tcs-${crypto.randomUUID().slice(0, 8)}.sock`;
  const frames: Array<{ type?: string }> = [];
  const bridge = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        try { frames.push(JSON.parse(line)); } catch { /* not a bridge frame */ }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    bridge.once("error", reject);
    bridge.listen(socketPath, resolve);
  });
  _setPtyBridgeSocketPath(socketPath);
  topicsHome = mkdtempSync(join(tmpdir(), "agent-spawn-home-"));
  writeFileSync(join(topicsHome, "daemon-state.json"), JSON.stringify({ pid: 1, port: 1, token: AGENT_TOKEN, startedAt: "x" }));
  process.env.TOPICS_HOME = topicsHome;

  const ctx = {
    db: {
      query: (sql: string) => ({
        get: () => sql.includes("SELECT provider, mcp_policy")
          ? { provider: "codex", mcp_policy: "bridge-only" }
          : null,
      }),
    },
    json: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status }),
    errorResponse: (status: number, error: string) => new Response(JSON.stringify({ error }), { status }),
    readJSON: (request: Request) => request.json(),
    matchRoute: (pathname: string, pattern: string) => {
      const path = pathname.split("/");
      const route = pattern.split("/");
      if (path.length !== route.length) return null;
      const params: Record<string, string> = {};
      for (let i = 0; i < route.length; i++) {
        if (route[i]!.startsWith(":")) params[route[i]!.slice(1)] = decodeURIComponent(path[i]!);
        else if (route[i] !== path[i]) return null;
      }
      return params;
    },
    broadcastToAll: () => {},
    worktreeStore: {},
  } as unknown as AppContext;
  try {
    const router = createTerminalRouter(ctx);
    const url = new URL("http://topics.test/api/sessions/topic%3Ablocked/agents/spawn");
    const response = await router(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-daemon-token": AGENT_TOKEN },
        body: JSON.stringify({ prompt: "must not start" }),
      }),
      url,
      url.pathname,
      "POST",
    );

    expect(response?.status).toBe(403);
    expect((await response!.json()).error).toMatch(/cannot spawn Claude sub-agents/i);
    expect(frames.filter((frame) => frame.type === "create")).toHaveLength(0);
  } finally {
    process.env.TOPICS_DISABLE_PTY_BRIDGE = "1";
    disconnectBridge();
    await new Promise<void>((resolve) => bridge.close(() => resolve()));
    if (existsSync(socketPath)) rmSync(socketPath, { force: true });
  }
});

test("stop_agent on a child whose run lives on a paired node cancels the run there, not a local process (sottoagenti-nodo, trace 4)", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "agent-spawn-node-"));
  const stateDir = join(tempRoot, "state");
  const machineId = "node-fake-1";
  const runId = "run-fake-1";
  const token = "t".repeat(32);
  const cancelCalls: Array<{ baseUrl: string; token: string; runId: string }> = [];
  topicsHome = join(tempRoot, "topics-home");
  mkdirSync(topicsHome, { recursive: true });
  writeFileSync(join(topicsHome, "daemon-state.json"), JSON.stringify({ pid: 1, port: 1, token: AGENT_TOKEN, startedAt: "x" }));
  process.env.TOPICS_HOME = topicsHome;
  mkdirSync(join(stateDir, "nodes"), { recursive: true });
  writeFileSync(join(stateDir, "nodes", `${machineId}.token`), token);

  initDatabase(resolve(import.meta.dir, "../.."), tempRoot);
  try {
    const agentId = crypto.randomUUID();
    const parentKey = "topic:fake-parent";
    insertSubagent(getDatabase(), {
      id: agentId, parentSessionKey: parentKey, name: "remote child", model: null, agentType: null, effort: null,
      promptSnippet: "do it on the node", cwd: tempRoot, branch: null, claudeSessionId: null, createdAt: new Date().toISOString(),
    });
    markSubagentRemote(getDatabase(), agentId, { machineId, runId });

    const ctx = {
      db: getDatabase(),
      STATE_DIR: stateDir,
      json: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
      errorResponse: (status: number, error: string) => new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json" } }),
      readJSON: (request: Request) => request.json(),
      matchRoute: (pathname: string, pattern: string) => {
        const path = pathname.split("/");
        const route = pattern.split("/");
        if (path.length !== route.length) return null;
        const params: Record<string, string> = {};
        for (let i = 0; i < route.length; i++) {
          if (route[i]!.startsWith(":")) params[route[i]!.slice(1)] = decodeURIComponent(path[i]!);
          else if (route[i] !== path[i]) return null;
        }
        return params;
      },
      broadcastToAll: () => {},
      worktreeStore: {},
      machineStore: { get: (id: string) => (id === machineId ? { baseUrl: "http://fake-node.test" } : null) },
      nodeClient: { cancelRun: async (input: { baseUrl: string; token: string; runId: string }) => { cancelCalls.push(input); } },
    } as unknown as AppContext;

    const router = createTerminalRouter(ctx);
    const url = new URL(`http://topics.test/api/sessions/${encodeURIComponent(parentKey)}/agents/${agentId}/stop`);
    const response = await router(
      new Request(url, { method: "POST", headers: { "x-daemon-token": AGENT_TOKEN } }),
      url,
      url.pathname,
      "POST",
    );

    expect(response?.status).toBe(200);
    expect(cancelCalls).toEqual([{ baseUrl: "http://fake-node.test", token, runId }]);
    const row = getDatabase().query("SELECT state FROM subagents WHERE id = ?").get(agentId) as { state: string };
    expect(row.state).toBe("stopped");
  } finally {
    try { closeDatabase(); } catch { /* best effort */ }
    try { rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* Windows may keep the sqlite file locked a moment; the temp dir is disposable */ }
  }
});

/** Shared setup for the read_agent/send_to_agent remote-child cases below: a node of this own, not the stop test's. */
function remoteChildCtx() {
  const tempRoot = mkdtempSync(join(tmpdir(), "agent-spawn-node-"));
  const stateDir = join(tempRoot, "state");
  const machineId = "node-fake-2";
  const runId = "run-fake-2";
  const token = "t".repeat(32);
  const topicsHome = join(tempRoot, "topics-home");
  mkdirSync(topicsHome, { recursive: true });
  writeFileSync(join(topicsHome, "daemon-state.json"), JSON.stringify({ pid: 1, port: 1, token: AGENT_TOKEN, startedAt: "x" }));
  process.env.TOPICS_HOME = topicsHome;
  mkdirSync(join(stateDir, "nodes"), { recursive: true });
  writeFileSync(join(stateDir, "nodes", `${machineId}.token`), token);
  initDatabase(resolve(import.meta.dir, "../.."), tempRoot);

  const agentId = crypto.randomUUID();
  const parentKey = "topic:fake-parent-2";
  insertSubagent(getDatabase(), {
    id: agentId, parentSessionKey: parentKey, name: "remote child", model: null, agentType: null, effort: null,
    promptSnippet: "do it on the node", cwd: tempRoot, branch: null, claudeSessionId: null, createdAt: new Date().toISOString(),
  });
  markSubagentRemote(getDatabase(), agentId, { machineId, runId });

  const baseCtx = {
    STATE_DIR: stateDir,
    json: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
    errorResponse: (status: number, error: string) => new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json" } }),
    readJSON: (request: Request) => request.json(),
    matchRoute: (pathname: string, pattern: string) => {
      const path = pathname.split("/");
      const route = pattern.split("/");
      if (path.length !== route.length) return null;
      const params: Record<string, string> = {};
      for (let i = 0; i < route.length; i++) {
        if (route[i]!.startsWith(":")) params[route[i]!.slice(1)] = decodeURIComponent(path[i]!);
        else if (route[i] !== path[i]) return null;
      }
      return params;
    },
    broadcastToAll: () => {},
    worktreeStore: {},
    machineStore: { get: (id: string) => (id === machineId ? { baseUrl: "http://fake-node.test" } : null) },
  };
  return { tempRoot, machineId, runId, token, agentId, parentKey, baseCtx };
}

test("read_agent on a child whose run lives on a paired node reads the node's report, not a local transcript (sottoagenti-nodo, trace 4)", async () => {
  const { tempRoot, runId, token, agentId, parentKey, baseCtx } = remoteChildCtx();
  const readCalls: Array<{ baseUrl: string; token: string; runId: string; since?: string }> = [];
  try {
    const ctx = {
      ...baseCtx,
      nodeClient: {
        readRun: async (input: { baseUrl: string; token: string; runId: string; since?: string }) => {
          readCalls.push(input);
          return { comments: [{ id: "c-1", content: "working on it", createdAt: "2026-11-15T12:00:00.000Z" }] };
        },
      },
    } as unknown as AppContext;

    const router = createTerminalRouter(ctx);
    const url = new URL(`http://topics.test/api/sessions/${encodeURIComponent(parentKey)}/agents/${agentId}/read`);
    const response = await router(
      new Request(url, { method: "GET", headers: { "x-daemon-token": AGENT_TOKEN } }),
      url,
      url.pathname,
      "GET",
    );

    expect(response?.status).toBe(200);
    expect(readCalls).toEqual([{ baseUrl: "http://fake-node.test", token, runId }]);
    const body = await response!.json();
    // `nextOffset` carries this process's own epoch (SUBAGENT-28): the index
    // itself (1, one event read) is what matters, not the raw number.
    expect(body).toEqual({
      ok: true,
      events: [{ type: "assistant", text: "working on it" }],
      nextOffset: expect.any(Number),
      source: "node",
    });
    expect(body.nextOffset % 10_000_000).toBe(1);
  } finally {
    try { closeDatabase(); } catch { /* best effort */ }
    try { rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* Windows may keep the sqlite file locked a moment; the temp dir is disposable */ }
  }
});

test("send_to_agent on a child whose run lives on a paired node is refused: a node run cannot take more input mid-run (sottoagenti-nodo, trace 4)", async () => {
  const { tempRoot, agentId, parentKey, baseCtx } = remoteChildCtx();
  try {
    const ctx = { ...baseCtx, nodeClient: {} } as unknown as AppContext;
    const router = createTerminalRouter(ctx);
    const url = new URL(`http://topics.test/api/sessions/${encodeURIComponent(parentKey)}/agents/${agentId}/send`);
    const response = await router(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-daemon-token": AGENT_TOKEN },
        body: JSON.stringify({ input: "keep going" }),
      }),
      url,
      url.pathname,
      "POST",
    );

    expect(response?.status).toBe(409);
    expect((await response!.json()).error).toMatch(/paired node/i);
  } finally {
    try { closeDatabase(); } catch { /* best effort */ }
    try { rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* Windows may keep the sqlite file locked a moment; the temp dir is disposable */ }
  }
});
