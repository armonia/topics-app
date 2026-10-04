/**
 * `spawn_agent` on the Topics engine (openspec/changes/subagent-nativi), through
 * the real terminal router and database. The chat route is a fake that plays
 * the engine's turn: it writes the child's answer into the child's chat and
 * deposits the turn's end, the two things a real native turn leaves behind.
 * A fake PTY bridge is there only to prove that no CLI starts, and that
 * `runtime: "claude-code"` still starts one.
 * @covers SUBAGENT-08, SUBAGENT-11, SUBAGENT-12, SUBAGENT-14, SUBAGENT-15, SUBAGENT-18, SUBAGENT-19, CHAT-NTOOL-03
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "./helpers";
import { startFakeClaudeBridge, type FakeBridge } from "./helpers/fake-claude-bridge";
import type { SubAgentExitInfo } from "../../server/routes/subagent-exit";
import type { AppContext, Topic } from "../../server/types";

const ROOT = testTmpDir("subagent-native");
const SOCKET_PATH = `${ROOT}/b.sock`;
const PROJECT = `${ROOT}/proj`;
const HOME = `${ROOT}/home`;
const TOKEN = "subagent-native-token";
const PARENT = "topic:7c1e0a55";
const OTHER_PARENT = "topic:7c1e0a66";

let bridge: FakeBridge;
let ctx: AppContext;
let router: (req: Request, url: URL, pathname: string, method: string) => Promise<Response | null> | Response | null;
const reports: SubAgentExitInfo[] = [];
const spawned: Array<{ parent: string; agentId: string }> = [];

/** What the fake engine was asked, and the turns it is holding open. */
const turns: Array<{ sessionKey: string; text: string }> = [];
const open = new Map<string, () => void>();
/** `hold`: the next turn stays open until it is aborted. `fail`: the route answers 503. */
let mode: "answer" | "hold" | "fail" = "answer";

async function fakeChatRoute(req: Request, _url: URL, pathname: string): Promise<Response | null> {
  const { recordTurnEnd } = await import("../../server/providers/turn-end-registry");
  const body = await req.json() as { sessionKey: string; messages?: Array<{ content: string }>; cause?: string };
  const sessionKey = body.sessionKey;
  if (pathname === "/api/chat/abort") {
    const close = open.get(sessionKey);
    if (!close) return Response.json({ ok: false, reason: "no_active_stream" });
    recordTurnEnd(sessionKey, { end: "cancelled", cause: "user" });
    close();
    return Response.json({ ok: true });
  }
  if (pathname !== "/api/chat") return null;
  const text = body.messages?.at(-1)?.content ?? "";
  turns.push({ sessionKey, text });
  if (mode === "fail") return Response.json({ error: "Questa chat è legata al motore di Topics, che non è connesso." }, { status: 503 });
  ctx.appendLocalMessage(sessionKey, "user", text);
  const holding = mode === "hold";
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const finish = () => { open.delete(sessionKey); controller.close(); };
      if (holding) {
        ctx.appendLocalMessage(sessionKey, "assistant", "half a sentence");
        open.set(sessionKey, finish);
        return;
      }
      ctx.appendLocalMessage(sessionKey, "assistant", `done: ${text}`);
      recordTurnEnd(sessionKey, { end: "end_turn" });
      queueMicrotask(finish);
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

async function call(path: string, method: string, body?: object): Promise<Response> {
  const url = new URL(`http://h${path}`);
  const res = await router(new Request(url, {
    method,
    headers: { "content-type": "application/json", "x-gateway-token": TOKEN },
    body: body ? JSON.stringify(body) : undefined,
  }), url, url.pathname, method);
  if (!res) throw new Error(`no route for ${method} ${path}`);
  return res;
}
const agents = (parent: string) => `/api/sessions/${encodeURIComponent(parent)}/agents`;

async function until<T>(what: string, probe: () => T | undefined | false | null, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = probe();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const creates = () => bridge.received.filter((m) => m.type === "create");
const reportsFor = (agentId: string) => reports.filter((r) => r.childId === agentId);
const rowOf = (agentId: string) => ctx.db.query("SELECT state, runtime, session_key, turns_reported, tools FROM subagents WHERE id = ?").get(agentId) as
  { state: string; runtime: string; session_key: string | null; turns_reported: number; tools: string | null } | null;

async function spawn(parent: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await call(`${agents(parent)}/spawn`, "POST", { prompt: "Find the call sites of deliverExit.", ...body });
  const json = await res.json() as Record<string, unknown>;
  if (res.status === 200) spawned.push({ parent, agentId: json.agentId as string });
  return { status: res.status, body: json };
}

function topic(sessionKey: string, model: string | null): void {
  const now = new Date().toISOString();
  ctx.saveSingleTopic({
    id: `${sessionKey.slice("topic:".length)}-0000-4000-8000-000000000001`, name: sessionKey, slug: sessionKey.slice(-6), parentId: null, links: [],
    sessionKey, color: "#aabbcc", icon: "chat", createdAt: now, updatedAt: now, archived: false, projectPath: PROJECT,
    ...(model ? { model } : {}),
  } as Topic);
}

beforeAll(async () => {
  setupTestDataDir(join(ROOT, "data"));
  fs.mkdirSync(PROJECT, { recursive: true });
  fs.mkdirSync(join(HOME, ".claude", "agents"), { recursive: true });
  fs.writeFileSync(join(HOME, ".claude", "agents", "scout.md"),
    "---\nname: scout\ndescription: Cheap read-only sweep.\nmodel: sonnet\neffort: low\ntools: Read, Grep, Glob, mcp__topics__list_agents\n---\nYou locate things and judge nothing.\n");
  delete process.env.TOPICS_DISABLE_PTY_BRIDGE;
  delete process.env.TOPICS_EMBEDDED;
  process.env.GATEWAY_TOKEN = TOKEN;
  process.env.CLAUDE_BIN = "/bin/echo";
  { const { _resetClaudeBinCache } = await import("../../server/lib/claude-bin"); _resetClaudeBinCache(); }
  bridge = await startFakeClaudeBridge(ROOT, SOCKET_PATH);
  ctx = await createTestAppContext();
  topic(PARENT, "claude-sonnet-5-5[1m]");
  topic(OTHER_PARENT, null);
  const terminal = await import("../../server/routes/terminal");
  terminal.disconnectBridge();
  terminal._setPtyBridgeSocketPath(SOCKET_PATH);
  terminal._setAgentProfilesHome(HOME);
  terminal._setTerminalTrackerForTests(null);
  terminal.setSubAgentExitHandler((info) => { reports.push(info); info.settle?.(); });
  router = terminal.createTerminalRouter(ctx) as typeof router;
  const native = await import("../../server/lib/native-subagents");
  native.configureNativeSubagents({
    route: fakeChatRoute,
    isBusy: (sk) => open.has(sk),
    getTopicBySessionKey: (sk) => ctx.getTopicBySessionKey(sk),
    saveTopic: (t) => ctx.saveSingleTopic(t),
    loadMessages: (sk) => ctx.loadLocalMessages(sk),
    engineReady: () => true,
  });
  await until("the reconcile list", () => bridge.received.some((m) => m.type === "list"), 5_000);
}, 30_000);

afterEach(async () => {
  mode = "answer";
  for (const close of [...open.values()]) close();
  for (const { parent, agentId } of spawned.splice(0)) {
    if (rowOf(agentId)?.state === "running") await call(`${agents(parent)}/${agentId}/stop`, "POST");
  }
});

afterAll(async () => {
  const native = await import("../../server/lib/native-subagents");
  native._resetNativeSubagents();
  const terminal = await import("../../server/routes/terminal");
  terminal.setSubAgentExitHandler(null);
  terminal._setAgentProfilesHome(null);
  process.env.TOPICS_DISABLE_PTY_BRIDGE = "1";
  terminal.disconnectBridge();
  terminal._setPtyBridgeSocketPath(null);
  await bridge?.close();
  delete process.env.CLAUDE_BIN;
  delete process.env.GATEWAY_TOKEN;
  { const { _resetClaudeBinCache } = await import("../../server/lib/claude-bin"); _resetClaudeBinCache(); }
  bridge?.cleanup();
  await cleanupTestDataDir(ROOT);
});

describe("a child is a chat on the Topics engine, not a CLI (SUBAGENT-18)", () => {
  test("no runtime asked: a chat pinned to the engine, on the parent's model and project, and no PTY", async () => {
    const before = creates().length;
    const { status, body } = await spawn(PARENT, { name: "finder" });
    expect(status).toBe(200);
    expect(body).toMatchObject({ runtime: "topics", model: "claude-sonnet-5-5[1m]", modelSource: "parent", notify: "chat" });
    expect(creates().length).toBe(before);
    const child = ctx.getTopicBySessionKey(body.sessionKey as string);
    expect(child).toMatchObject({ provider: "topics", model: "claude-sonnet-5-5[1m]", projectPath: PROJECT, name: "finder" });
    expect(rowOf(body.agentId as string)).toMatchObject({ runtime: "topics", session_key: body.sessionKey });
    // The prompt went to the child's chat, through the chat route.
    expect(turns.at(-1)).toEqual({ sessionKey: body.sessionKey as string, text: "Find the call sites of deliverExit." });
  });

  test("the turn's end is one result for the parent, from the child's chat, and the slot is freed", async () => {
    const { body } = await spawn(PARENT, { name: "reporter" });
    const id = body.agentId as string;
    const report = await until("the report", () => reportsFor(id)[0]);
    expect(report).toMatchObject({ parentSessionKey: PARENT, name: "reporter", turn: 1, outcome: { status: "completed", partial: false, text: "done: Find the call sites of deliverExit." } });
    expect(rowOf(id)).toMatchObject({ state: "retired", turns_reported: 1 });
  });

  test("send_to_agent is the chat's next turn, reported as turn 2", async () => {
    const { body } = await spawn(PARENT, {});
    const id = body.agentId as string;
    await until("turn 1", () => reportsFor(id)[0]);
    const res = await call(`${agents(PARENT)}/${id}/send`, "POST", { input: "and the callers of those" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, resumed: true });
    const second = await until("turn 2", () => reportsFor(id)[1]);
    expect(second).toMatchObject({ turn: 2, outcome: { status: "completed", text: "done: and the callers of those" } });
  });

  test("read_agent reads the child's chat", async () => {
    const { body } = await spawn(PARENT, {});
    const id = body.agentId as string;
    await until("the report", () => reportsFor(id)[0]);
    const read = await (await call(`${agents(PARENT)}/${id}/read`, "GET")).json() as { events: Array<{ text?: string }>; source: string; nextOffset: number };
    expect(read.source).toBe("chat");
    expect(read.events.map((e) => e.text)).toEqual(["done: Find the call sites of deliverExit."]);
    const again = await (await call(`${agents(PARENT)}/${id}/read?since=${read.nextOffset}`, "GET")).json() as { events: unknown[] };
    expect(again.events).toEqual([]);
  });

  test("a route that refuses the turn is a failed result that says why", async () => {
    mode = "fail";
    const { body } = await spawn(PARENT, {});
    const report = await until("the report", () => reportsFor(body.agentId as string)[0]);
    expect(report.outcome).toMatchObject({ status: "failed", reason: { code: "api-error" } });
    expect((report.outcome.reason as { detail: string }).detail).toContain("503");
  });

  test("runtime: claude-code still starts the CLI", async () => {
    const before = creates().length;
    const { status, body } = await spawn(PARENT, { runtime: "claude-code" });
    expect(status).toBe(200);
    expect(body.runtime).toBe("claude-code");
    await until("the create frame", () => creates().length > before);
    expect(rowOf(body.agentId as string)?.runtime).toBe("claude-code");
  });

  // 04/10: pop-demo riscriveva a «arte-tappa-1», nato sulla CLI, e ogni
  // ripresa riapriva un Claude Code. Ora riparte nativo, stesso id.
  test("a stopped CLI child, written to again, comes back on the engine with its task, not with --resume", async () => {
    const { body } = await spawn(PARENT, { runtime: "claude-code", name: "arte-tappa-1" });
    const id = body.agentId as string;
    await call(`${agents(PARENT)}/${id}/stop`, "POST");
    ctx.db.run("UPDATE subagents SET state = 'stopped', claude_session_id = ? WHERE id = ?", ["00000000-0000-4000-8000-0000000000aa", id]);
    const before = creates().length;
    const res = await call(`${agents(PARENT)}/${id}/send`, "POST", { input: "now the bastion" });
    expect(res.status).toBe(200);
    const sent = await res.json() as Record<string, unknown>;
    expect(sent).toMatchObject({ ok: true, resumed: true, runtime: "topics" });
    expect(creates().length).toBe(before);
    expect(rowOf(id)).toMatchObject({ runtime: "topics", session_key: sent.sessionKey });
    const turn = await until("the migrated turn", () => turns.find((t) => t.sessionKey === sent.sessionKey));
    expect(turn.text).toContain("«arte-tappa-1»");
    expect(turn.text.toLowerCase()).toContain("find the call sites of deliverexit.");
    expect(turn.text.endsWith("now the bastion")).toBe(true);
    expect(await until("its result", () => reportsFor(id).find((r) => r.outcome.status === "completed"))).toBeTruthy();
  });

  // 04/10: le schede dei figli ritirati restavano aperte perche' questa lista
  // le dava per parcheggiate, e al clic riaprivano Claude Code.
  test("a retired sub-agent is not in the parked list a project tab would revive", async () => {
    const insert = ctx.db.prepare(
      "INSERT INTO terminal_sessions (id, name, cwd, command, type, created_at, status, parent_session_key) VALUES (?, ?, ?, 'claude', 'claude-code', ?, 'dormant', ?)",
    );
    const now = new Date().toISOString();
    insert.run("dormant-person-0001", "mine", PROJECT, now, null);
    insert.run("dormant-child-0001", "retired child", PROJECT, now, PARENT);
    const res = await call(`/api/terminal/sessions/dormant?cwd=${encodeURIComponent(PROJECT)}`, "GET");
    const ids = (await res.json() as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toContain("dormant-person-0001");
    expect(ids).not.toContain("dormant-child-0001");
    ctx.db.run("DELETE FROM terminal_sessions WHERE id IN ('dormant-person-0001', 'dormant-child-0001')");
  });

  test("an unknown runtime is refused", async () => {
    const { status } = await spawn(PARENT, { runtime: "codex" });
    expect(status).toBe(400);
  });
});

describe("a profile shapes the child's chat (SUBAGENT-09 on the engine)", () => {
  test("its instructions become the system prompt, its tools the engine's names", async () => {
    const { body } = await spawn(PARENT, { agent_type: "scout" });
    expect(body).toMatchObject({ agentType: "scout", model: "claude-sonnet-5-5", effort: "low" });
    const child = ctx.getTopicById(ctx.getTopicBySessionKey(body.sessionKey as string)!.id);
    expect(child?.systemPrompt).toBe("You locate things and judge nothing.");
    expect(JSON.parse(rowOf(body.agentId as string)!.tools!)).toEqual(["read_file", "grep", "glob", "list_agents"]);
    const { nativeSubagentToolPolicy, toolAllowedByPolicy } = await import("../../server/lib/subagent-tool-policy");
    const policy = nativeSubagentToolPolicy(body.sessionKey as string);
    expect(toolAllowedByPolicy(policy, "read_file")).toBe(true);
    expect(toolAllowedByPolicy(policy, "bash")).toBe(false);
  });
});

describe("stopping (SUBAGENT-11, 14)", () => {
  test("stop_agent mid-turn: the turn ends `stopped` by the parent, the chat is archived, and it wakes nobody", async () => {
    mode = "hold";
    const { body } = await spawn(PARENT, {});
    const id = body.agentId as string;
    await until("the turn open", () => open.has(body.sessionKey as string));
    const res = await call(`${agents(PARENT)}/${id}/stop`, "POST");
    expect(res.status).toBe(200);
    const report = await until("the report", () => reportsFor(id)[0]);
    expect(report).toMatchObject({ stoppedByParent: true, outcome: { status: "stopped", partial: true, text: "half a sentence", reason: { code: "stopped-by-parent" } } });
    expect(rowOf(id)?.state).toBe("stopped");
    expect(ctx.getTopicBySessionKey(body.sessionKey as string)?.archived).toBe(true);
  });

  test("a person's Stop on the parent stops the native children working for it", async () => {
    mode = "hold";
    const { body } = await spawn(PARENT, {});
    const id = body.agentId as string;
    await until("the turn open", () => open.has(body.sessionKey as string));
    const { stopNativeChildrenOf } = await import("../../server/lib/native-subagents");
    expect(await stopNativeChildrenOf(PARENT)).toBe(1);
    const report = await until("the report", () => reportsFor(id)[0]);
    expect(report.outcome.status).toBe("stopped");
    expect(rowOf(id)?.state).toBe("stopped");
    // Interrupted, not dismissed: the chat stays where the person can read it.
    expect(ctx.getTopicBySessionKey(body.sessionKey as string)?.archived).toBe(false);
  });

  test("while a child works, the parent's goal sees background work (no «Objective still open»)", async () => {
    mode = "hold";
    const { body } = await spawn(OTHER_PARENT, {});
    await until("the turn open", () => open.has(body.sessionKey as string));
    const { subagentWakeState } = await import("../../server/lib/subagent-runtime");
    expect(subagentWakeState(OTHER_PARENT)).toBe("running");
  });
});

describe("depth 2: a child delegates once, a grandchild does not (SUBAGENT-15, CHAT-NTOOL-03)", () => {
  test("child → grandchild is allowed, grandchild → great-grandchild is refused and sees no delegation tools", async () => {
    const child = await spawn(OTHER_PARENT, { name: "child" });
    await until("child's turn", () => reportsFor(child.body.agentId as string)[0]);
    const grand = await spawn(child.body.sessionKey as string, { name: "grandchild" });
    expect(grand.status).toBe(200);
    await until("grandchild's turn", () => reportsFor(grand.body.agentId as string)[0]);
    const great = await spawn(grand.body.sessionKey as string, { name: "great" });
    expect(great.status).toBe(429);
    expect(String(great.body.error)).toContain("depth limit (2)");
    const { nativeSubagentToolPolicy, toolAllowedByPolicy } = await import("../../server/lib/subagent-tool-policy");
    expect(toolAllowedByPolicy(nativeSubagentToolPolicy(child.body.sessionKey as string), "spawn_agent")).toBe(true);
    expect(toolAllowedByPolicy(nativeSubagentToolPolicy(grand.body.sessionKey as string), "spawn_agent")).toBe(false);
  });

  test("native children working hold slots: the sixth live one under a parent is refused", async () => {
    mode = "hold";
    for (let i = 0; i < 5; i++) expect((await spawn(OTHER_PARENT, { name: `slot ${i}` })).status).toBe(200);
    const sixth = await spawn(OTHER_PARENT, { name: "slot 5" });
    expect(sixth.status).toBe(429);
  });
});
