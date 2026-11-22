/**
 * @covers TERM-14
 *
 * Exercise the resumed-agent route across the bridge boundary: a lone suspend
 * byte must not revive a child, and a filtered Unicode prompt must be accepted
 * against the transcript the CLI actually wrote.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import net from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { closeDatabase, getDatabase, initDatabase } from "../db";
import { configureNativeSubagents, _resetNativeSubagents } from "../lib/native-subagents";
import { insertSubagent } from "../lib/subagent-store";
import { recordTurnStart } from "../providers/turn-end-registry";
import { createTerminalRouter, disconnectBridge } from "./terminal";
import { _setPtyBridgeSocketPath } from "./terminal-bridge-socket";
import { _resetRosterReconciled } from "./terminal-bridge-roster";
import { _setSeedPromptHandlerForTests, subAgentNotFound } from "./terminal-children";
import type { AppContext, RouteHandler } from "../types";

const SUSPEND = String.fromCharCode(26);
// The daemon token, the only credential of the agent routes.
const daemonToken = crypto.randomUUID().replace(/-/g, "").repeat(2);
const HOME_KEYS = ["HOME", "DATA_DIR", "TOPICS_DATA_DIR", "APP_DATA_DIR", "CLAUDE_BIN", "TOPICS_HOME", "TOPICS_DISABLE_PTY_BRIDGE"] as const;
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
  process.env.TOPICS_HOME = join(tempRoot, "topics-home");
  mkdirSync(process.env.TOPICS_HOME, { recursive: true });
  writeFileSync(join(process.env.TOPICS_HOME, "daemon-state.json"), JSON.stringify({ pid: 1, port: 1, token: daemonToken, startedAt: "x" }));
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
    projectStore: { getByPath: (path: string) => (path === join(tempRoot, "project") ? { path } : null) },
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
        headers: { "content-type": "application/json", "x-daemon-token": daemonToken },
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
    _setSeedPromptHandlerForTests((childId, prompt, acceptSnippet) => {
      seeds.push({ childId, prompt, acceptSnippet });
    });
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

describe("resumed terminal sends with the engine ready", () => {
  test("moves an ended CLI child to the engine with the filtered prompt and its byte count", async () => {
    const id = crypto.randomUUID();
    const rawPrompt = `é${SUSPEND}🧭`;
    const filteredPrompt = "é🧭";
    addEndedChild({ id, claudeSessionId: crypto.randomUUID() });
    const received: string[] = [];
    configureNativeSubagents({
      route: async (req) => {
        const body = await req.json() as { sessionKey: string; clientMessageId: string; messages: Array<{ content: string }> };
        received.push(...body.messages.map((message) => message.content));
        recordTurnStart(body.sessionKey, "resume-moved-turn", { byPerson: false, key: body.clientMessageId });
        return new Response(null, { status: 200 });
      },
      isBusy: () => false,
      getTopicBySessionKey: () => null,
      saveTopic: () => {},
      loadMessages: () => [],
      engineReady: () => true,
    });
    let seeded = false;
    _setSeedPromptHandlerForTests(() => { seeded = true; });
    bridgeFrames.length = 0;

    try {
      const response = await requestSend(id, rawPrompt);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        sent: Buffer.byteLength(filteredPrompt, "utf8"),
        resumed: true,
        runtime: "topics",
      });
      await Bun.sleep(50);
      expect(received.length).toBeGreaterThan(0);
      expect(received.join("\n")).toContain(filteredPrompt);
      expect(received.join("\n")).not.toContain(SUSPEND);
      expect(seeded).toBe(false);
      expect(bridgeFrames.some((frame) => frame.type === "create")).toBe(false);
    } finally {
      _setSeedPromptHandlerForTests(null);
      configureNativeSubagents(null);
      _resetNativeSubagents();
    }
  });
});

describe("a native child driven from a session that did not spawn it", () => {
  /** A scheduled run opens a fresh chat each time: not the parent the child was born under. */
  const OTHER = "topic:other-caller";
  const PARENT = "topic:resume-parent";

  async function requestAs(caller: string, agentId: string, action: "send" | "read" | "stop", body?: object): Promise<Response> {
    const url = new URL(`http://topics.test/api/sessions/${encodeURIComponent(caller)}/agents/${agentId}/${action}`);
    const response = await router(
      new Request(url, {
        method: action === "read" ? "GET" : "POST",
        headers: { "content-type": "application/json", "x-daemon-token": daemonToken },
        body: body ? JSON.stringify(body) : undefined,
      }),
      url,
      url.pathname,
      action === "read" ? "GET" : "POST",
    );
    if (!response) throw new Error(`no route for ${action}`);
    return response;
  }

  function configureIdleEngine(): void {
    configureNativeSubagents({
      route: async (req) => {
        const body = await req.json() as { sessionKey: string; clientMessageId: string };
        recordTurnStart(body.sessionKey, "cross-session-turn", { byPerson: false, key: body.clientMessageId });
        return new Response(null, { status: 200 });
      },
      isBusy: () => false,
      getTopicBySessionKey: () => null,
      saveTopic: () => {},
      loadMessages: () => [],
      engineReady: () => true,
    });
  }

  test("send is accepted and names the parent session its result wakes", async () => {
    const id = crypto.randomUUID();
    addEndedChild({ id, runtime: "topics", sessionKey: `child:${id}` });
    configureIdleEngine();
    try {
      const response = await requestAs(OTHER, id, "send", { input: "continue" });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, resumed: true, wakes: PARENT });
    } finally {
      configureNativeSubagents(null);
      _resetNativeSubagents();
    }
  });

  test("send from the parent itself carries no wakes field", async () => {
    const id = crypto.randomUUID();
    addEndedChild({ id, runtime: "topics", sessionKey: `child:${id}` });
    configureIdleEngine();
    try {
      const response = await requestAs(PARENT, id, "send", { input: "continue" });
      expect(response.status).toBe(200);
      expect(await response.json()).not.toHaveProperty("wakes");
    } finally {
      configureNativeSubagents(null);
      _resetNativeSubagents();
    }
  });

  test("read is open to any session", async () => {
    const id = crypto.randomUUID();
    addEndedChild({ id, runtime: "topics", sessionKey: `child:${id}` });
    const response = await requestAs(OTHER, id, "read");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ events: [], source: "chat" });
  });

  test("stop stays with the parent: another session gets a 404 that names the owner", async () => {
    const id = crypto.randomUUID();
    addEndedChild({ id, runtime: "topics", sessionKey: `child:${id}` });
    const response = await requestAs(OTHER, id, "stop");
    expect(response.status).toBe(404);
    const { error } = await response.json() as { error: string };
    expect(error).toContain(PARENT);
    expect(getDatabase().query("SELECT state FROM subagents WHERE id = ?").get(id)).toEqual({ state: "retired" });
  });
});

describe("subAgentNotFound", () => {
  test("an id that exists under another session says whose it is", () => {
    const id = crypto.randomUUID();
    addEndedChild({ id, runtime: "topics", sessionKey: `child:${id}` });
    const message = subAgentNotFound(id);
    expect(message).toContain("resume test child");
    expect(message).toContain("topic:resume-parent");
    expect(message).toContain("only that session can drive it");
  });

  test("an id that exists nowhere stays the bare answer", () => {
    expect(subAgentNotFound(crypto.randomUUID())).toBe("sub-agent not found");
  });

  test("a built-in Agent tool id keeps its own explanation", () => {
    expect(subAgentNotFound("a6a16ed2dbeb2ede4")).toContain("built-in Agent tool");
  });
});
