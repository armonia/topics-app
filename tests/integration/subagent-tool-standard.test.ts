/**
 * `spawn_agent` at the standard of Claude Code's `Agent` tool, through the
 * real terminal router and a fake PTY bridge that plays the CLI
 * (`helpers/fake-claude-bridge.ts`): the flags a child starts with, one result
 * per turn without the process exiting, the foreground wait, the retirement
 * and the resume, and the limits counted from the database. No `claude`
 * process is ever started.
 * @covers SUBAGENT-08, SUBAGENT-09, SUBAGENT-10, SUBAGENT-11, SUBAGENT-13, SUBAGENT-14, SUBAGENT-15, SUBAGENT-17
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "./helpers";
import { startFakeClaudeBridge, type FakeBridge, type FakeChild } from "./helpers/fake-claude-bridge";
import type { SubAgentExitInfo } from "../../server/routes/subagent-exit";
import type { AppContext, Topic } from "../../server/types";

const ROOT = testTmpDir("subagent-std");
const SOCKET_PATH = `${ROOT}/b.sock`;
const PROJECT = `${ROOT}/proj`;
const HOME = `${ROOT}/home`;
const TOKEN = "subagent-std-token";
const topicKey = (n: number) => `topic:5a738995-0000-4000-8000-00000000010${n}`;
const SONNET_CHAT = topicKey(1);
const GPT_CHAT = topicKey(2);
const MEDIUM_CHAT = topicKey(3);

let bridge: FakeBridge;
let ctx: AppContext;
let router: (req: Request, url: URL, pathname: string, method: string) => Promise<Response | null> | Response | null;
const reports: SubAgentExitInfo[] = [];
const spawned: Array<{ parent: string; agentId: string }> = [];

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

async function until<T>(what: string, probe: () => T | undefined | false | null, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = probe();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function untilAsync<T>(what: string, probe: () => Promise<T | undefined | false | null>, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const creates = () => bridge.received.filter((m) => m.type === "create");
const argsOf = (agentId: string) => creates().filter((m) => m.id === agentId).at(-1)?.args ?? [];
const flag = (args: string[], name: string) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined);
const reportsFor = (agentId: string) => reports.filter((r) => r.childId === agentId);
const rowOf = (agentId: string) => ctx.db.query("SELECT state, turns_reported, ended_at FROM subagents WHERE id = ?").get(agentId) as { state: string; turns_reported: number; ended_at: string | null } | null;
const hasPrompt = (child: FakeChild, text: string) => {
  const file = bridge.transcriptFile(child.cwd, child.sessionId);
  return !!file && fs.existsSync(file) && fs.readFileSync(file, "utf-8").split("\n").some((l) => l.includes('"type":"user"') && l.includes(text));
};
const endTurn = (child: FakeChild, text: string, model = "claude-sonnet-5-5") =>
  bridge.append(child, { type: "assistant", message: { model, role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] } });

async function spawn(parent: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown>; child?: FakeChild }> {
  const before = creates().length;
  const res = await call(`${agents(parent)}/spawn`, "POST", { prompt: "Find the call sites of deliverExit.", ...body });
  const json = await res.json() as Record<string, unknown>;
  if (res.status === 200) spawned.push({ parent, agentId: json.agentId as string });
  else expect(creates().length).toBe(before);
  return { status: res.status, body: json, child: res.status === 200 ? bridge.children.get(json.agentId as string) : undefined };
}

function topic(sessionKey: string, model: string | null, provider: string | null = null): void {
  const now = new Date().toISOString();
  ctx.saveSingleTopic({
    id: sessionKey.slice("topic:".length), name: sessionKey, slug: sessionKey.slice(-6), parentId: null, links: [], sessionKey,
    color: "#aabbcc", icon: "chat", createdAt: now, updatedAt: now, archived: false, projectPath: PROJECT,
    ...(model ? { model } : {}), ...(provider ? { provider } : {}),
  } as Topic);
}

function profile(dir: string, file: string, text: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(dir, file), text);
}

beforeAll(async () => {
  setupTestDataDir(join(ROOT, "data"));
  fs.mkdirSync(PROJECT, { recursive: true });
  profile(join(HOME, ".claude", "agents"), "scout.md", "---\nname: scout\ndescription: Cheap read-only sweep.\nmodel: sonnet\neffort: low\n---\nYou locate things.\n");
  profile(join(HOME, ".claude", "agents"), "verifier.md", "---\nname: verifier\ndescription: Refutes one claim.\neffort: xhigh\n---\nbody\n");
  profile(join(PROJECT, ".claude", "agents"), "verifier.md", "---\nname: verifier\ndescription: The project's verifier.\neffort: high\n---\nbody\n");
  delete process.env.TOPICS_DISABLE_PTY_BRIDGE;
  delete process.env.TOPICS_EMBEDDED;
  process.env.GATEWAY_TOKEN = TOKEN;
  // A path that exists: the bridge is fake, so nothing ever runs it.
  process.env.CLAUDE_BIN = "/bin/echo";
  { const { _resetClaudeBinCache } = await import("../../server/lib/claude-bin"); _resetClaudeBinCache(); }
  bridge = await startFakeClaudeBridge(ROOT, SOCKET_PATH);
  ctx = await createTestAppContext();
  topic(SONNET_CHAT, "claude-sonnet-5-5[1m]");
  topic(GPT_CHAT, "gpt-5.6-sol", "codex");
  topic(MEDIUM_CHAT, "claude-opus-5[1m]");
  ctx.db.run("UPDATE topics SET effort = 'medium' WHERE session_key = ?", [MEDIUM_CHAT]);
  const terminal = await import("../../server/routes/terminal");
  terminal.disconnectBridge();
  terminal._setPtyBridgeSocketPath(SOCKET_PATH);
  terminal._setAgentProfilesHome(HOME);
  terminal.setSubAgentExitHandler((info) => { reports.push(info); });
  router = terminal.createTerminalRouter(ctx) as typeof router;
  await until("the reconcile list", () => bridge.received.some((m) => m.type === "list"), 5_000);
}, 30_000);

// Every child goes at the end of its test: the machine-wide cap counts them all.
afterEach(async () => {
  for (const { parent, agentId } of spawned.splice(0)) {
    if (rowOf(agentId)?.state === "running") await call(`${agents(parent)}/${agentId}/stop`, "POST");
  }
});

afterAll(async () => {
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

describe("the child starts with the model, profile and effort it was given (SUBAGENT-08, 09, 10)", () => {
  test("a model named by the call reaches the CLI, and the answer says where it came from", async () => {
    const { status, body } = await spawn(SONNET_CHAT, { model: "sonnet" });
    expect(status).toBe(200);
    expect(flag(argsOf(body.agentId as string), "--model")).toBe("sonnet");
    expect(body).toMatchObject({ model: "sonnet", modelSource: "call", cwd: PROJECT, notify: "chat" });
  }, 30_000);

  test("a sonnet chat opens a sonnet child", async () => {
    const { body } = await spawn(SONNET_CHAT, {});
    expect(flag(argsOf(body.agentId as string), "--model")).toBe("claude-sonnet-5-5[1m]");
    expect(body.modelSource).toBe("parent");
  }, 30_000);

  test("a chat on a GPT model hands nothing down, and the answer says why", async () => {
    const { body } = await spawn(GPT_CHAT, { model: "inherit" });
    expect(argsOf(body.agentId as string)).not.toContain("--model");
    expect(body.modelNote).toBe("default (parent model gpt-5.6-sol is not a Claude model)");
  }, 30_000);

  test("an unknown model is refused before any process starts", async () => {
    const { status, body } = await spawn(SONNET_CHAT, { model: "gpt-5" });
    expect(status).toBe(400);
    expect(body.error).toContain("inherit, sonnet, opus, fable, haiku");
  });

  test("the scout profile is honoured with its own model and effort", async () => {
    const { body } = await spawn(SONNET_CHAT, { agent_type: "scout" });
    const args = argsOf(body.agentId as string);
    expect([flag(args, "--agent"), flag(args, "--model"), flag(args, "--effort")]).toEqual(["scout", "sonnet", "low"]);
    expect(body).toMatchObject({ agentType: "scout", effort: "low" });
  }, 30_000);

  test("an explicit model beats the profile's", async () => {
    const { body } = await spawn(SONNET_CHAT, { agent_type: "scout", model: "opus" });
    expect(flag(argsOf(body.agentId as string), "--model")).toBe("opus");
  }, 30_000);

  test("the project's profile wins over the user's on a name clash", async () => {
    const { body } = await spawn(SONNET_CHAT, { agent_type: "verifier" });
    expect(flag(argsOf(body.agentId as string), "--effort")).toBe("high");
  }, 30_000);

  test("an unknown profile is refused with the names that exist", async () => {
    const { status, body } = await spawn(SONNET_CHAT, { agent_type: "nobody" });
    expect(status).toBe(400);
    expect(body.error).toContain("use one of scout, verifier");
  });

  test("the parent topic's effort override reaches the child", async () => {
    const { body } = await spawn(MEDIUM_CHAT, {});
    const args = argsOf(body.agentId as string);
    expect(flag(args, "--effort")).toBe("medium");
    // Exactly one effort flag: the launch's, not a second one from the topic chain.
    expect(args.filter((a) => a === "--effort").length).toBe(1);
  }, 30_000);
});

describe("one result per turn, without waiting for the process to exit (SUBAGENT-11)", () => {
  test("two turns, two results, the second through send_to_agent; a stop when idle adds nothing", async () => {
    const { body, child } = await spawn(SONNET_CHAT, { name: "foglio-tab", prompt: "Find the call sites of deliverExit." });
    const agentId = body.agentId as string;
    await until("the prompt record", () => hasPrompt(child!, "Find the call sites"));
    const phase = async () => ((await (await call(agents(SONNET_CHAT), "GET")).json()) as { agents: Array<{ agentId: string; phase: string }> }).agents.find((a) => a.agentId === agentId)?.phase;
    await untilAsync("the working phase", async () => (await phase()) === "working");
    endTurn(child!, "Report: 3 files");
    const [first] = await until("the first result", () => reportsFor(agentId).length > 0 && reportsFor(agentId), 15_000);
    expect(first).toMatchObject({ name: "foglio-tab", turn: 1, model: "claude-sonnet-5-5", outcome: { status: "completed", text: "Report: 3 files", partial: false } });
    expect(rowOf(agentId)).toMatchObject({ state: "running", turns_reported: 1 });
    expect(await phase()).toBe("finished");

    expect((await call(`${agents(SONNET_CHAT)}/${agentId}/send`, "POST", { input: "Now the tests that cover them." })).status).toBe(200);
    await until("the second prompt", () => hasPrompt(child!, "Now the tests"));
    endTurn(child!, "Two tests.");
    await until("the second result", () => reportsFor(agentId).length === 2, 15_000);
    expect(reportsFor(agentId)[1]).toMatchObject({ turn: 2, outcome: { status: "completed", text: "Two tests." } });

    expect((await call(`${agents(SONNET_CHAT)}/${agentId}/stop`, "POST")).status).toBe(200);
    await new Promise((r) => setTimeout(r, 3_000));
    expect(reportsFor(agentId).length).toBe(2);
    expect(rowOf(agentId)?.state).toBe("stopped");
  }, 60_000);
});

describe("a foreground spawn waits for the result (SUBAGENT-13)", () => {
  test("the wait returns the report, and the same turn is not delivered to the chat as well", async () => {
    const { body, child } = await spawn(SONNET_CHAT, { run_in_background: false });
    const agentId = body.agentId as string;
    expect(body.runInBackground).toBe(false);
    await until("the prompt record", () => hasPrompt(child!, "Find the call sites"));
    const first = await (await call(`${agents(SONNET_CHAT)}/${agentId}/wait?legMs=200`, "GET")).json();
    expect(first).toEqual({ status: "running", agentId });
    const waiting = call(`${agents(SONNET_CHAT)}/${agentId}/wait?legMs=15000`, "GET");
    endTurn(child!, "Report: 3 files");
    const done = await (await waiting).json() as { status: string; result: { turn: number; status: string; text: string } };
    expect(done.status).toBe("done");
    expect(done.result).toMatchObject({ turn: 1, status: "completed", text: "Report: 3 files" });
    await new Promise((r) => setTimeout(r, 2_500));
    expect(reportsFor(agentId)).toEqual([]);
  }, 60_000);

  test("a call that hands over releases the hold, and the result reaches the chat", async () => {
    const { body, child } = await spawn(SONNET_CHAT, { run_in_background: false });
    const agentId = body.agentId as string;
    await until("the prompt record", () => hasPrompt(child!, "Find the call sites"));
    expect(await (await call(`${agents(SONNET_CHAT)}/${agentId}/wait?release=1`, "GET")).json()).toEqual({ status: "running", agentId });
    endTurn(child!, "Late report");
    await until("the result in the chat", () => reportsFor(agentId).length > 0, 15_000);
  }, 60_000);
});

describe("a finished child is retired, and comes back with --resume (SUBAGENT-14)", () => {
  test("idle after its report it is retired without a second result, and send_to_agent resumes it with the same flags", async () => {
    const terminal = await import("../../server/routes/terminal");
    const { body, child } = await spawn(SONNET_CHAT, { agent_type: "scout", name: "scout-r" });
    const agentId = body.agentId as string;
    await until("the prompt record", () => hasPrompt(child!, "Find the call sites"));
    endTurn(child!, "Report: 3 files");
    await until("the result", () => reportsFor(agentId).length === 1, 15_000);
    // 15 minutes later, said to the clock instead of waited for.
    await until("the retirement", () => terminal.retireIdleSubAgents({ now: Date.now() + 16 * 60_000, idleMs: 0 }).includes(agentId) || rowOf(agentId)?.state === "retired", 10_000);
    await until("the PTY gone", () => !terminal.getTerminalSessionById(agentId), 5_000);
    expect(rowOf(agentId)?.state).toBe("retired");
    await new Promise((r) => setTimeout(r, 2_500));
    expect(reportsFor(agentId).length).toBe(1);
    // A retired child holds no slot, and it is still listed, as retired.
    const list = (await (await call(agents(SONNET_CHAT), "GET")).json()) as { agents: Array<{ agentId: string; state: string }> };
    expect(list.agents.find((a) => a.agentId === agentId)?.state).toBe("retired");

    const sessionId = child!.sessionId;
    const resumed = await call(`${agents(SONNET_CHAT)}/${agentId}/send`, "POST", { input: "And the tests?" });
    expect(await resumed.json()).toMatchObject({ ok: true, resumed: true });
    const args = argsOf(agentId);
    expect(flag(args, "--resume")).toBe(sessionId);
    expect([flag(args, "--agent"), flag(args, "--model"), flag(args, "--effort")]).toEqual(["scout", "sonnet", "low"]);
    expect(rowOf(agentId)?.state).toBe("running");
    await until("the resumed input delivered", () => hasPrompt(bridge.children.get(agentId)!, "And the tests?"), 20_000);
  }, 90_000);

  test("a stopped child is resumed from its row after a restart, not refused with 404", async () => {
    const terminal = await import("../../server/routes/terminal");
    const { body, child } = await spawn(SONNET_CHAT, { name: "after-restart" });
    const agentId = body.agentId as string;
    await until("the prompt record", () => hasPrompt(child!, "Find the call sites"));
    expect((await call(`${agents(SONNET_CHAT)}/${agentId}/stop`, "POST")).status).toBe(200);
    await until("the stopped row", () => rowOf(agentId)?.state === "stopped");
    terminal._forgetSubAgentMemory();
    const res = await call(`${agents(SONNET_CHAT)}/${agentId}/send`, "POST", { input: "Carry on." });
    expect(res.status).toBe(200);
    expect(flag(argsOf(agentId), "--resume")).toBe(child!.sessionId);
  }, 60_000);

  test("a CLI Agent id gets a 404 that says so, and a child ended a day ago answers 410", async () => {
    const res = await call(`${agents(SONNET_CHAT)}/a6a16ed2dbeb2ede4/send`, "POST", { input: "hi" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toContain("built-in Agent tool");

    const { body, child } = await spawn(SONNET_CHAT, { name: "too-old" });
    const agentId = body.agentId as string;
    await until("the prompt record", () => hasPrompt(child!, "Find the call sites"));
    await call(`${agents(SONNET_CHAT)}/${agentId}/stop`, "POST");
    ctx.db.run("UPDATE subagents SET ended_at = ? WHERE id = ?", [new Date(Date.now() - 25 * 3_600_000).toISOString(), agentId]);
    const old = await call(`${agents(SONNET_CHAT)}/${agentId}/send`, "POST", { input: "Carry on." });
    expect(old.status).toBe(410);
    expect(((await old.json()) as { error: string }).error).toContain("more than 24 hours ago");
    const list = (await (await call(agents(SONNET_CHAT), "GET")).json()) as { agents: Array<{ agentId: string }> };
    expect(list.agents.some((a) => a.agentId === agentId)).toBe(false);
  }, 60_000);
});

describe("limits counted from the rows (SUBAGENT-15)", () => {
  const seedRunning = (id: string, parent: string) => ctx.db.run(
    "INSERT INTO subagents (id, parent_session_key, name, cwd, created_at) VALUES (?, ?, ?, ?, ?)",
    [id, parent, `held-${id}`, PROJECT, new Date().toISOString()],
  );
  afterEach(() => { ctx.db.run("UPDATE subagents SET state = 'stopped', ended_at = ? WHERE name LIKE 'held-%'", [new Date().toISOString()]); });

  test("six live sub-agents under three chats refuse a seventh, naming who holds the slots", async () => {
    for (let i = 0; i < 6; i++) seedRunning(`g${i}`, topicKey(4 + (i % 3)));
    const { status, body } = await spawn(SONNET_CHAT, {});
    expect(status).toBe(429);
    expect(body.error).toContain("machine-wide limit of 6");
    for (let i = 0; i < 6; i++) expect(body.error).toContain(`"held-g${i}" (${topicKey(4 + (i % 3))})`);
  });

  test("five children of a parent still count after a restart emptied the live map", async () => {
    for (let i = 0; i < 5; i++) seedRunning(`p${i}`, MEDIUM_CHAT);
    const { status, body } = await spawn(MEDIUM_CHAT, {});
    expect(status).toBe(429);
    expect(body.error).toContain("max 5 live sub-agents per session");
  });
});
