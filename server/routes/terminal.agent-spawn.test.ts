import { afterEach, expect, test } from "bun:test";
import { existsSync, rmSync } from "fs";
import net from "net";
import { _setPtyBridgeSocketPath, createTerminalRouter, disconnectBridge } from "./terminal";

const originalGatewayToken = process.env.GATEWAY_TOKEN;
const originalStandalone = process.env.TOPICS_DISABLE_PTY_BRIDGE;

afterEach(() => {
  if (originalGatewayToken === undefined) delete process.env.GATEWAY_TOKEN;
  else process.env.GATEWAY_TOKEN = originalGatewayToken;
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
  process.env.GATEWAY_TOKEN = "test-agent-token";

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
  } as any;
  const router = createTerminalRouter(ctx);
  const url = new URL("http://topics.test/api/sessions/topic%3Ablocked/agents/spawn");
  const response = await router(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gateway-token": "test-agent-token" },
      body: JSON.stringify({ prompt: "must not start" }),
    }),
    url,
    url.pathname,
    "POST",
  );

  expect(response?.status).toBe(403);
  expect((await response!.json()).error).toMatch(/cannot spawn Claude sub-agents/i);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(frames.filter((frame) => frame.type === "create")).toHaveLength(0);

  process.env.TOPICS_DISABLE_PTY_BRIDGE = "1";
  disconnectBridge();
  await new Promise<void>((resolve) => bridge.close(() => resolve()));
  if (existsSync(socketPath)) rmSync(socketPath, { force: true });
});
