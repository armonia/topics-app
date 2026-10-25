/**
 * @covers TERM-14
 *
 * Exercise the resumed-agent route across the bridge boundary: a lone suspend
 * byte must not revive a child, and a filtered Unicode prompt must be accepted
 * against the transcript the CLI actually wrote.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import net from "node:net";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { closeDatabase, getDatabase, initDatabase } from "../db";
import { configureNativeSubagents, _resetNativeSubagents } from "../lib/native-subagents";
import { insertSubagent } from "../lib/subagent-store";
import { recordTurnStart } from "../providers/turn-end-registry";
import {
  _resetRosterReconciled,
  _setSeedPromptHandlerForTests,
  _setPtyBridgeSocketPath,
  createTerminalRouter,
  disconnectBridge,
} from "./terminal";
import type { AppContext, RouteHandler } from "../types";

const SUSPEND = String.fromCharCode(26);
const gatewayAuthToken = crypto.randomUUID();
const HOME_KEYS = ["HOME", "DATA_DIR", "TOPICS_DATA_DIR", "APP_DATA_DIR", "CLAUDE_BIN", "GATEWAY_TOKEN", "TOPICS_DISABLE_PTY_BRIDGE"] as const;
const priorEnv = new Map<string, string | undefined>();
const bridgeFrames: Array<Record<string, unknown>> = [];
let tempRoot = "";
let socketPath = "";
let bufferText = "for shortcuts";
let bridge: net.Server;
let router: RouteHandler;

beforeAll(async () => {
  tempRoot = mkdtempSync(join(tmpdir(), "terminal-suspend-route-"));
  for (const key of HOME_KEYS) priorEnv.set(key, process.env[key]);
  process.env.HOME = join(tempRoot, "home");
  process.env.DATA_DIR = join(tempRoot, "data");
  process.env.TOPICS_DATA_DIR = join(tempRoot, "state");
  process.env.APP_DATA_DIR = join(tempRoot, "app");
  process.env.CLAUDE_BIN = "/bin/sh";
  process.env.GATEWAY_TOKEN = gatewayAuthToken;
  delete process.env.TOPICS_DISABLE_PTY_BRIDGE;
  mkdirSync(process.env.HOME, { recursive: true });
  mkdirSync(join(tempRoot, "project"), { recursive: true });
  initDatabase(resolve(import.meta.dir, "../.."), tempRoot);

  socketPath = `/tmp/tsr-${crypto.randomUUID().slice(0, 8)}.sock`;
  bridge = net.createServer((socket) => {
    let pending = "";
    socket.on("data", (chunk) => {
      pending += chunk.toString();
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        let frame: Record<string, unknown>;
        try { frame = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        bridgeFrames.push(frame);
        if (frame.type === "ping") socket.write(JSON.stringify({ type: "pong" }) + "\n");
        else if (frame.type === "list") socket.write(JSON.stringify({ type: "list", sessions: [] }) + "\n");
        else if (frame.type === "create") socket.write(JSON.stringify({ type: "created", id: frame.id, pid: process.pid }) + "\n");
        else if (frame.type === "buffer") socket.write(JSON.stringify({ type: "buffer", id: frame.id, data: Buffer.from(bufferText).toString("base64") }) + "\n");
      }
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    bridge.once("error", reject);
    bridge.listen(socketPath, resolveListen);
  });
  _setPtyBridgeSocketPath(socketPath);
  _resetRosterReconciled();
  const ctx = {
    db: getDatabase(),
    json: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
    errorResponse: (status: number, error: string) => new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json" } }),
    readJSON: (req: Request) => req.json(),
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
    projectStore: { getByPath: () => null },
    getTopicBySessionKey: () => null,
  } as unknown as AppContext;
  router = createTerminalRouter(ctx);
  await requestSend("missing-child", "probe");
});

afterAll(async () => {
  configureNativeSubagents(null);
  _resetNativeSubagents();
  _setSeedPromptHandlerForTests(null);
  disconnectBridge();
  _setPtyBridgeSocketPath(null);
  if (bridge?.listening) await new Promise<void>((resolveClose) => bridge.close(() => resolveClose()));
  try { closeDatabase(); } catch { /* the setup may have failed before opening it */ }
  try { rmSync(socketPath, { force: true }); } catch { /* best effort */ }
  try { rmSync(tempRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  for (const key of HOME_KEYS) {
    const value = priorEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function addEndedChild(options: { id: string; runtime?: "claude-code" | "topics"; sessionKey?: string | null; claudeSessionId?: string | null }): void {
  const cwd = join(tempRoot, "project");
  insertSubagent(getDatabase(), {
    id: options.id,
    parentSessionKey: "topic:resume-parent",
    name: "resume test child",
    model: null,
    agentType: null,
    effort: null,
    promptSnippet: "the original prompt",
    cwd,
    branch: null,
    claudeSessionId: options.claudeSessionId ?? null,
    runtime: options.runtime ?? "claude-code",
    sessionKey: options.sessionKey ?? null,
    createdAt: new Date().toISOString(),
  });
  getDatabase().run("UPDATE subagents SET state = 'retired', ended_at = ? WHERE id = ?", [new Date().toISOString(), options.id]);
}

async function requestSend(agentId: string, input: string): Promise<Response> {
  const url = new URL(`http://topics.test/api/sessions/topic%3Aresume-parent/agents/${agentId}/send`);
  for (let attempt = 0; attempt < 80; attempt++) {
    const response = await router(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-gateway-token": gatewayAuthToken },
        body: JSON.stringify({ input }),
      }),
      url,
      url.pathname,
      "POST",
    );
    if (response && response.status !== 503) return response;
    await Bun.sleep(10);
  }
  throw new Error("terminal route did not finish roster reconciliation");
}

describe("resumed terminal sends", () => {
  test("drops a lone suspend key without reviving the ended CLI child", async () => {
    const id = crypto.randomUUID();
    addEndedChild({ id, claudeSessionId: crypto.randomUUID() });
    let seeded = false;
    _setSeedPromptHandlerForTests(() => { seeded = true; });
    bridgeFrames.length = 0;

    const response = await requestSend(id, SUSPEND);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, dropped: true, sent: 0 });
    expect(seeded).toBe(false);
    expect(bridgeFrames.some((frame) => frame.type === "create" || frame.type === "write")).toBe(false);
    expect(getDatabase().query("SELECT id FROM terminal_sessions WHERE id = ?").get(id)).toBeNull();
    expect(getDatabase().query("SELECT state FROM subagents WHERE id = ?").get(id)).toEqual({ state: "retired" });
    _setSeedPromptHandlerForTests(null);
  });

  test("passes the filtered Unicode prompt and transcript fingerprint to seeding", async () => {
    const id = crypto.randomUUID();
    const claudeSessionId = crypto.randomUUID();
    const rawPrompt = `é${SUSPEND}🧭`;
    const filteredPrompt = "é🧭";
    addEndedChild({ id, claudeSessionId });
    bufferText = `for shortcuts\n> ${filteredPrompt}`;
    const seeds: Array<{ childId: string; prompt: string; acceptSnippet?: string }> = [];
    _setSeedPromptHandlerForTests((childId, prompt, acceptSnippet) => seeds.push({ childId, prompt, acceptSnippet }));
    bridgeFrames.length = 0;

    const response = await requestSend(id, rawPrompt);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, sent: Buffer.byteLength(filteredPrompt, "utf8"), resumed: true });
    expect(seeds).toEqual([{ childId: id, prompt: filteredPrompt, acceptSnippet: filteredPrompt }]);
    _setSeedPromptHandlerForTests(null);
  });

  test("reports the native child input's UTF-8 byte count", async () => {
    const id = crypto.randomUUID();
    const sessionKey = `topic:${crypto.randomUUID().slice(0, 8)}`;
    const input = "é🧭";
    addEndedChild({ id, runtime: "topics", sessionKey });
    let received = "";
    configureNativeSubagents({
      route: async (req) => {
        const body = await req.json() as { sessionKey: string; clientMessageId: string; messages: Array<{ content: string }> };
        received = body.messages[0]?.content ?? "";
        recordTurnStart(body.sessionKey, "resume-test-turn", { byPerson: false, key: body.clientMessageId });
        return new Response(null, { status: 200 });
      },
      isBusy: () => false,
      getTopicBySessionKey: () => null,
      saveTopic: () => {},
      loadMessages: () => [],
      engineReady: () => true,
    });

    const response = await requestSend(id, input);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, sent: Buffer.byteLength(input, "utf8"), resumed: true });
    expect(received).toBe(input);
    configureNativeSubagents(null);
    _resetNativeSubagents();
  });
});
