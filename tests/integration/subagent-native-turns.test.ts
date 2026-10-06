/**
 * One turn of a native sub-agent, one result, attributed by the turn's name:
 * on the REAL engine, the native provider and the whole topics router (chat
 * route, abort route) as the server runs them, with only the network faked.
 * Review 4 of PR 238 (05/10) pinned each defect here with a repro on that
 * engine: two results for one turn, a result after the Stop, a result read
 * off the wrong turn. Each test is one of those repros, its assertion inverted.
 * @covers SUBAGENT-11, SUBAGENT-12, SUBAGENT-19, SUBAGENT-22
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "./helpers";
import { startFakeClaudeBridge, type FakeBridge } from "./helpers/fake-claude-bridge";
import type { SubAgentExitInfo } from "../../server/routes/subagent-exit";
import type { AppContext, Topic } from "../../server/types";

const ROOT = testTmpDir("subagent-native-turns");
const SOCKET_PATH = `${ROOT}/b.sock`;
const PROJECT = `${ROOT}/proj`;
const AGENTS_HOME = `${ROOT}/agents-home`;
const TOKEN = "native-turns-token";
const ROOT_KEY = "topic:f2f2f2f2";
const REAL_HOME = process.env.HOME;
const realFetch = globalThis.fetch;
const DEBOUNCE_MS = 50;
const POLL_MS = 50;

let bridge: FakeBridge;
let ctx: AppContext;
let terminalRouter: (req: Request, url: URL, pathname: string, method: string) => Promise<Response | null> | Response | null;
let route: (req: Request, url: URL, pathname: string, method: string) => Promise<Response | null>;
const reports: SubAgentExitInfo[] = [];
/** How long an aborted model request takes to unwind (a slow provider). */
let slowAbortMs = 0;
/** Runs when the abort route is called for this chat, before it answers. */
let abortHook: { sk: string; fn: () => Promise<void> | void } | null = null;
/** Results the wake wrote as plain rows instead of a turn: `[parent chat, child id]`. */
const resultRows: Array<[string, string]> = [];
/** Background work the child chat's own process claims (a command). */
const busyBackground = new Set<string>();

// ── The network: the Messages API, answering at once or held on a marker ─────

/** Turns whose request carries one of these markers wait for their release (or their abort). */
const held = new Map<string, Array<() => void>>();
let modelCalls = 0;

function sse(events: object[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

function finalRound(text: string, stopReason = "end_turn"): string {
  return sse([
    { type: "message_start", message: { usage: { input_tokens: 10 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 2 } },
  ]);
}

function hold(marker: string): void { held.set(marker, []); }
function release(marker: string): void {
  const waiting = held.get(marker) ?? [];
  held.delete(marker);
  for (const go of waiting) go();
}

async function fakeNetwork(_input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const body = typeof init?.body === "string" ? init.body : "";
  modelCalls++;
  const marker = [...held.keys()].find((m) => body.includes(m));
  if (marker) {
    await new Promise<void>((resolve, reject) => {
      held.get(marker)!.push(resolve);
      init?.signal?.addEventListener("abort", () => {
        const fail = () => reject(new DOMException("aborted", "AbortError"));
        if (slowAbortMs > 0) setTimeout(fail, slowAbortMs); else fail();
      });
    });
  }
  // A real tool that runs a while: the bash tool, interrupted by the Stop.
  if (body.includes("TASK-BASH") && !body.includes("tool_result")) {
    return new Response(sse([
      { type: "message_start", message: { usage: { input_tokens: 10 } } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_turns_1", name: "bash", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ command: "sleep 30" }) } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 2 } },
    ]), { status: 200 });
  }
  if (body.includes("TASK-MAXTOK")) return new Response(finalRound("cut short", "max_tokens"), { status: 200 });
  return new Response(finalRound(`answer ${modelCalls}`), { status: 200 });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function call(path: string, method: string, body?: object): Promise<Response> {
  const url = new URL(`http://h${path}`);
  const res = await terminalRouter(new Request(url, { method, headers: { "content-type": "application/json", "x-gateway-token": TOKEN }, body: body ? JSON.stringify(body) : undefined }), url, url.pathname, method);
  if (!res) throw new Error(`no route for ${method} ${path}`);
  return res;
}
const agents = (parent: string) => `/api/sessions/${encodeURIComponent(parent)}/agents`;
async function until<T>(what: string, probe: () => T | undefined | false | null, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) { const v = probe(); if (v) return v; if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 25)); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const reportsFor = (id: string) => reports.filter((r) => r.childId === id);
const statusesOf = (id: string) => reportsFor(id).map((r) => [r.turn, r.outcome.status, r.stoppedByParent ?? false]);
const rowOf = (id: string) => ctx.db.query("SELECT state FROM subagents WHERE id = ?").get(id) as { state: string } | null;
const busy = (sk: string) => ctx.activeStreams.has(sk);
const userTurns = (sk: string) => ctx.loadLocalMessages(sk).filter((m) => m.role === "user").length;
async function spawn(parent: string, body: Record<string, unknown>) {
  const res = await call(`${agents(parent)}/spawn`, "POST", body);
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}
function topic(sessionKey: string): Topic {
  const now = new Date().toISOString();
  const t = { id: `${sessionKey.slice(6)}-0000-4000-8000-000000000001`, name: sessionKey, slug: sessionKey.slice(-6), parentId: null, links: [], sessionKey, color: "#aabbcc", icon: "chat", createdAt: now, updatedAt: now, archived: false, projectPath: PROJECT, provider: "topics" } as Topic;
  ctx.saveSingleTopic(t);
  return t;
}
/** A turn on a chat, as the client sends it; its stream drained in the background. */
async function chatTurn(sessionKey: string, content: string): Promise<number> {
  const url = new URL("http://localhost/api/chat");
  const res = await route(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionKey, messages: [{ role: "user", content }] }) }), url, "/api/chat", "POST");
  if (res?.body) void (async () => { const r = res.body!.getReader(); while (!(await r.read()).done) { /* drain */ } })();
  return res?.status ?? 0;
}
/** A Stop, as the client sends it (`cause` for «Send now»). */
async function abortChat(sessionKey: string, cause?: string): Promise<number> {
  const url = new URL("http://localhost/api/chat/abort");
  const res = await route(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionKey, ...(cause ? { cause } : {}) }) }), url, url.pathname, "POST");
  return res?.status ?? 0;
}

beforeAll(async () => {
  setupTestDataDir(join(ROOT, "data"));
  fs.mkdirSync(PROJECT, { recursive: true });
  fs.mkdirSync(join(AGENTS_HOME, ".claude", "agents"), { recursive: true });
  // The engine's credentials: a token the fake network never checks.
  const home = join(ROOT, "home");
  fs.mkdirSync(join(home, ".claude"), { recursive: true });
  fs.writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fake", refreshToken: "r", expiresAt: Date.now() + 3_600_000 } }));
  process.env.HOME = home;
  globalThis.fetch = fakeNetwork as typeof fetch;
  delete process.env.TOPICS_DISABLE_PTY_BRIDGE;
  delete process.env.TOPICS_EMBEDDED;
  process.env.GATEWAY_TOKEN = TOKEN;
  process.env.CLAUDE_BIN = "/bin/echo";
  { const { _resetClaudeBinCache } = await import("../../server/lib/claude-bin"); _resetClaudeBinCache(); }
  bridge = await startFakeClaudeBridge(ROOT, SOCKET_PATH);
  ctx = await createTestAppContext();
  (ctx as { broadcastToAll: (m: unknown) => void }).broadcastToAll = () => {};
  (ctx as { broadcastToTopicSubscribers: (id: string, m: unknown) => void }).broadcastToTopicSubscribers = () => {};
  topic(ROOT_KEY);
  ctx.projectStore.create({ name: "proj", slug: "proj-turns", path: PROJECT });

  // The engine, registered as the server registers it, and the whole topics router.
  const { registerProvider } = await import("../../server/providers");
  registerProvider({ type: "native" } as never);
  const { createTopicsRouter, reopenDepsFor } = await import("../../server/routes/topics");
  const topics = createTopicsRouter(ctx);
  route = async (req, url, pathname, method) => {
    if (pathname === "/api/chat/abort" && abortHook) {
      const body = await req.clone().text();
      if (body.includes(abortHook.sk)) { const h = abortHook; abortHook = null; await h.fn(); }
    }
    return (await topics(req, url, pathname, method)) ?? null;
  };

  const terminal = await import("../../server/routes/terminal");
  terminal.disconnectBridge();
  terminal._setPtyBridgeSocketPath(SOCKET_PATH);
  terminal._setAgentProfilesHome(AGENTS_HOME);
  terminal._setTerminalTrackerForTests(null);
  // The parent's wake as server.ts starts it, with its verdict: the module's
  // own, so the abort route's Stop reaches the wakes it queued.
  const { startSubagentWakes } = await import("../../server/services/subagent-wake");
  const { subAgentResultOf } = await import("../../server/routes/subagent-exit");
  const { runningTaskOwnsTopic, stoppedSubagentChat, wakeVerdict } = await import("../../server/lib/wake-adoption");
  const wake = startSubagentWakes({
    route, isBusy: busy,
    canWake: (sk) => {
      const t = ctx.getTopicBySessionKey(sk);
      return !t || wakeVerdict({ id: t.id, archived: t.archived }, (id) => runningTaskOwnsTopic(ctx.db, id), (id) => stoppedSubagentChat(ctx.db, id)) !== "adopt" ? "row" : "wake";
    },
    debounceMs: DEBOUNCE_MS, pollMs: POLL_MS, endGraceMs: 500,
  });
  terminal.setSubAgentExitHandler((info) => {
    reports.push(info);
    wake.request({
      parentSessionKey: info.parentSessionKey, result: subAgentResultOf(info),
      writeRow: () => { resultRows.push([info.parentSessionKey, info.childId]); }, settle: () => info.settle?.(),
    });
  });
  terminalRouter = terminal.createTerminalRouter(ctx) as typeof terminalRouter;

  const { archiveTopicFully, reopenTopicFully } = await import("../../server/services/archive-topic");
  const { recordRetirement } = await import("../../server/services/retirement");
  const archiveDeps = {
    getTopicById: ctx.getTopicById, saveSingleTopic: ctx.saveSingleTopic, loadUnread: ctx.loadUnread,
    saveUnreadEntries: ctx.saveUnreadEntries, broadcastToAll: () => {}, purgeFromUiState: () => ({ ok: true as const }),
    recordRetirement: (id: string, at: string) => recordRetirement(ctx.db, "topic", id, at, "archive"),
  };
  const native = await import("../../server/lib/native-subagents");
  // As server.ts wires them.
  native.configureNativeSubagents({
    route,
    isBusy: busy,
    getTopicBySessionKey: (sk) => ctx.getTopicBySessionKey(sk),
    saveTopic: (t) => ctx.saveSingleTopic(t),
    loadMessages: (sk) => ctx.loadLocalMessages(sk),
    engineReady: () => true,
    archive: (t) => { archiveTopicFully(archiveDeps, t.id); },
    reopen: (t) => { reopenTopicFully(reopenDepsFor(ctx, () => {}), t.id); },
    backgroundWork: (sk) => busyBackground.has(sk),
    waitPollMs: 100,
  });
  await until("the reconcile list", () => bridge.received.some((m) => m.type === "list"), 5_000);
}, 30_000);

afterEach(async () => {
  busyBackground.clear();
  slowAbortMs = 0;
  abortHook = null;
  for (const m of [...held.keys()]) release(m);
  await until("the root free", () => !busy(ROOT_KEY));
});

afterAll(async () => {
  for (const m of [...held.keys()]) release(m);
  const native = await import("../../server/lib/native-subagents");
  native._resetNativeSubagents();
  const { _resetSubagentWakes } = await import("../../server/services/subagent-wake");
  _resetSubagentWakes();
  const terminal = await import("../../server/routes/terminal");
  terminal.setSubAgentExitHandler(null);
  terminal._setAgentProfilesHome(null);
  process.env.TOPICS_DISABLE_PTY_BRIDGE = "1";
  terminal.disconnectBridge();
  terminal._setPtyBridgeSocketPath(null);
  const { removeProvider } = await import("../../server/providers");
  try { removeProvider("topics"); } catch { /* already gone */ }
  await bridge?.close();
  bridge?.cleanup();
  globalThis.fetch = realFetch;
  if (REAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = REAL_HOME;
  delete process.env.CLAUDE_BIN;
  delete process.env.GATEWAY_TOKEN;
  { const { _resetClaudeBinCache } = await import("../../server/lib/claude-bin"); _resetClaudeBinCache(); }
  await cleanupTestDataDir(ROOT);
});

describe("one turn, one result, by the turn's name (SUBAGENT-19)", () => {
  // Probe a: a grandchild's result queued while the child's driven turn runs.
  // The wake turn opened right after the driven one, and the driven turn's two
  // ends were read against whichever turn was open.
  test("a driven turn and the wake turn after it: two turns, two results", async () => {
    for (let k = 0; k < 3; k++) {
      const marker = `TASK-RACE-${k}`;
      hold(marker);
      const c = await spawn(ROOT_KEY, { name: `race-${k}`, prompt: marker });
      const cid = c.body.agentId as string; const childKey = c.body.sessionKey as string;
      await until("child busy", () => busy(childKey));
      const g = await spawn(childKey, { name: `g-${k}`, prompt: `fast grand ${k}` });
      await until("grand reported", () => reportsFor(g.body.agentId as string)[0]);
      await sleep(DEBOUNCE_MS + 100 + k * 150);
      release(marker);
      await until("both turns reported", () => reportsFor(cid).length >= 2, 20_000);
      await sleep(POLL_MS * 4 + 1_000);
      expect(userTurns(childKey)).toBe(2);
      expect(reportsFor(cid).map((r) => [r.turn, r.outcome.status])).toEqual([[1, "completed"], [2, "completed"]]);
      expect(reportsFor(cid)[0]!.outcome.text).not.toBe(reportsFor(cid)[1]!.outcome.text);
    }
  }, 120_000);

  // Probe f: «Send now» in a child's chat during its wake turn, the provider
  // slow to unwind. The wake turn's late end was read against the person's
  // turn, and the person's answer went out as `stopped`.
  test("«Send now» during a wake turn: the person's turn is reported with its own answer", async () => {
    hold("TASK-SN-CHILD");
    const c = await spawn(ROOT_KEY, { name: "sn-child", prompt: "TASK-SN-CHILD" });
    const cid = c.body.agentId as string; const sk = c.body.sessionKey as string;
    busyBackground.add(sk);
    release("TASK-SN-CHILD");
    await until("turn 1 reported", () => reportsFor(cid)[0]);
    hold("WAKE-HELD");
    expect(await chatTurn(sk, "<subagent-result>WAKE-HELD</subagent-result>")).toBe(200);
    await until("wake busy", () => busy(sk));
    slowAbortMs = 1_500;
    const { SEND_NOW_STOP_CAUSE } = await import("../../shared/types");
    await abortChat(sk, SEND_NOW_STOP_CAUSE);
    // The held request stays pending until its slow abort.
    held.delete("WAKE-HELD");
    hold("PERSON-MSG");
    expect(await chatTurn(sk, "PERSON-MSG please answer")).toBe(200);
    await sleep(2_000);
    release("PERSON-MSG");
    await until("person turn done", () => !busy(sk));
    busyBackground.delete(sk);
    await until("three results", () => reportsFor(cid).length >= 3);
    await sleep(1_000);
    const rows = ctx.loadLocalMessages(sk);
    const personAt = rows.findIndex((m) => m.role === "user" && m.content.startsWith("PERSON-MSG"));
    const personAnswer = rows.slice(personAt + 1).find((m) => m.role === "assistant")!.content;
    expect(reportsFor(cid).map((r) => [r.turn, r.outcome.status])).toEqual([[1, "completed"], [2, "stopped"], [3, "completed"]]);
    expect(reportsFor(cid)[2]!.outcome.text).toBe(personAnswer);
  }, 60_000);

  // Probe i: the person's Stop in a child's chat while a real bash tool runs.
  // The abort route's end and the late finalize were two results.
  test("a Stop in the child's chat during a bash tool: one stopped result", async () => {
    const c = await spawn(ROOT_KEY, { name: "bash-stop", prompt: "TASK-BASH run something long" });
    const id = c.body.agentId as string; const sk = c.body.sessionKey as string;
    await until("busy", () => busy(sk));
    await sleep(800);
    await abortChat(sk);
    await until("its result", () => reportsFor(id)[0]);
    await sleep(2_500);
    expect(statusesOf(id)).toEqual([[1, "stopped", false]]);
  }, 30_000);

  // Probe h: the same Stop during a model request.
  test("a Stop in the child's chat during its driven turn: one stopped result, a person's", async () => {
    hold("TASK-OWN-STOP");
    const c = await spawn(ROOT_KEY, { name: "own-stop", prompt: "TASK-OWN-STOP" });
    const id = c.body.agentId as string; const sk = c.body.sessionKey as string;
    await until("busy", () => busy(sk));
    await abortChat(sk);
    held.delete("TASK-OWN-STOP");
    await until("its result", () => reportsFor(id)[0]);
    await sleep(2_000);
    expect(statusesOf(id)).toEqual([[1, "stopped", false]]);
  }, 30_000);
});

describe("nothing after a Stop wakes anyone (SUBAGENT-11)", () => {
  // Probe b: a child's result waited for the root's turn; the person stopped
  // the root, and the queued result woke it as soon as the turn let it go.
  test("the person's Stop on the root turns the results waiting to wake it into rows", async () => {
    hold("TASK-ROOT-STOP");
    expect(await chatTurn(ROOT_KEY, "TASK-ROOT-STOP")).toBe(200);
    await until("root busy", () => busy(ROOT_KEY));
    const c = await spawn(ROOT_KEY, { name: "quick", prompt: "quick child" });
    const cid = c.body.agentId as string;
    await until("child reported", () => reportsFor(cid)[0]);
    await sleep(300);
    const usersBefore = userTurns(ROOT_KEY);
    expect(await abortChat(ROOT_KEY)).toBe(200);
    await sleep(2_000);
    expect(userTurns(ROOT_KEY) - usersBefore).toBe(0);
    expect(resultRows).toContainEqual([ROOT_KEY, cid]);
  }, 30_000);

  // Probe c: the child's model answered while the Stop was still stopping the
  // grandchild; the child, not yet `stopped`, reported `completed` and woke the root.
  test("a child's turn that ends while the Stop is busy below it: one result, the Stop's", async () => {
    hold("TASK-WINDOW-CHILD");
    const c = await spawn(ROOT_KEY, { name: "window-child", prompt: "TASK-WINDOW-CHILD" });
    const cid = c.body.agentId as string; const childKey = c.body.sessionKey as string;
    await until("child busy", () => busy(childKey));
    hold("TASK-WINDOW-GRAND");
    const g = await spawn(childKey, { name: "window-grand", prompt: "TASK-WINDOW-GRAND" });
    const grandKey = g.body.sessionKey as string;
    await until("grand busy", () => busy(grandKey));
    abortHook = { sk: grandKey, fn: async () => { release("TASK-WINDOW-CHILD"); await until("child free", () => !busy(childKey)); await sleep(50); } };
    const rootUsersBefore = userTurns(ROOT_KEY);
    expect(await abortChat(ROOT_KEY)).toBe(200);
    await until("the child's result", () => reportsFor(cid)[0]);
    await sleep(1_500);
    expect(userTurns(ROOT_KEY) - rootUsersBefore).toBe(0);
    expect(statusesOf(cid)).toEqual([[1, "stopped", true]]);
    expect(rowOf(cid)?.state).toBe("stopped");
  }, 30_000);

  // Probe g: a person's Stop during the boot's adoption minute; the adoption
  // then reported the cut turn `lost`, which woke the root after the Stop.
  // Review 7: the cut turn's one result is the Stop's, which wakes nobody.
  test("a Stop during the boot's adoption: the cut turn's one result is the Stop's, and the root is not woken", async () => {
    const c = await spawn(ROOT_KEY, { name: "adopt-stop", prompt: "adopt stop child" });
    const id = c.body.agentId as string; const sk = c.body.sessionKey as string;
    await until("turn 1", () => reportsFor(id)[0]);
    await until("child free", () => !busy(sk));
    // The process died during turn 2: row still running, its message in the chat.
    ctx.db.run("UPDATE subagents SET state = 'running', ended_at = NULL WHERE id = ?", [id]);
    await sleep(5);
    const cut = ctx.appendLocalMessage(sk, "user", "turn 2, cut by the restart") as { id: string };
    const { recordTurnStarted } = await import("../../server/lib/subagent-store");
    recordTurnStarted(ctx.db as never, id, cut.id);
    const { resetTurnEndRegistry } = await import("../../server/providers/turn-end-registry");
    resetTurnEndRegistry();
    const native = await import("../../server/lib/native-subagents");
    const adoption = native.adoptNativeChildrenAtBoot({ waitMs: 2_000, pollMs: 50 });
    await sleep(200);
    const rootUsersBefore = userTurns(ROOT_KEY);
    expect(await abortChat(ROOT_KEY)).toBe(200);
    expect(rowOf(id)?.state).toBe("stopped");
    await adoption;
    await sleep(1_500);
    expect(statusesOf(id)).toEqual([[1, "completed", false], [2, "stopped", true]]);
    expect(userTurns(ROOT_KEY) - rootUsersBefore).toBe(0);
  }, 30_000);

  // Probe d: the `stopped` verdict runs a real query on a real row.
  test("the wake verdict: the root adopts, a stopped child is refused", async () => {
    const { stoppedSubagentChat, wakeVerdict, runningTaskOwnsTopic } = await import("../../server/lib/wake-adoption");
    hold("TASK-VERDICT");
    const c = await spawn(ROOT_KEY, { name: "verdict", prompt: "TASK-VERDICT" });
    const sk = c.body.sessionKey as string;
    await until("busy", () => busy(sk));
    const { stopNativeChildrenOf } = await import("../../server/lib/native-subagents");
    await stopNativeChildrenOf(ROOT_KEY);
    const verdict = (t: Topic) => wakeVerdict(t, (id) => runningTaskOwnsTopic(ctx.db, id), (id) => stoppedSubagentChat(ctx.db, id));
    expect(verdict(ctx.getTopicBySessionKey(ROOT_KEY)!)).toBe("adopt");
    expect(verdict(ctx.getTopicBySessionKey(sk)!)).toBe("stopped");
  }, 30_000);
});

describe("a person writing in a stopped child's chat resumes it (SUBAGENT-22)", () => {
  // Probe e: the person's turn left the child `stopped`: its result never
  // went out, and the helper it spawned wrote a row instead of waking it.
  test("the person's turn reopens the child: its result goes out and its helper wakes it", async () => {
    hold("TASK-RESUME-BY-HAND");
    const c = await spawn(ROOT_KEY, { name: "by-hand", prompt: "TASK-RESUME-BY-HAND" });
    const cid = c.body.agentId as string; const sk = c.body.sessionKey as string;
    await until("busy", () => busy(sk));
    const { stopNativeChildrenOf } = await import("../../server/lib/native-subagents");
    await stopNativeChildrenOf(ROOT_KEY);
    await until("child free", () => !busy(sk));
    release("TASK-RESUME-BY-HAND");
    await until("the Stop's result", () => reportsFor(cid)[0]);
    // The person, in the child's chat; during the turn the child delegates.
    hold("BY-HAND-PERSON");
    expect(await chatTurn(sk, "BY-HAND-PERSON go on")).toBe(200);
    await until("person turn busy", () => busy(sk));
    expect(rowOf(cid)?.state).toBe("running");
    const g = await spawn(sk, { name: "helper", prompt: "helper task" });
    const gid = g.body.agentId as string;
    await until("helper reported", () => reportsFor(gid)[0]);
    const usersBefore = userTurns(sk);
    release("BY-HAND-PERSON");
    await until("the helper's wake reported", () => reportsFor(cid).length >= 3, 15_000);
    await sleep(500);
    expect(statusesOf(cid)).toEqual([[1, "stopped", true], [2, "completed", false], [3, "completed", false]]);
    expect(userTurns(sk) - usersBefore).toBe(1);
    expect(resultRows.some(([p, id]) => p === sk && id === gid)).toBe(false);
  }, 30_000);
});

describe("the boot closes a child the way the live path would", () => {
  // Point 6 of review 4: the boot read `endReason === "done"`, which also
  // covers max_tokens, a refusal and the round cap, and archived a child whose
  // last turn had failed.
  test("a child whose last turn failed on max_tokens stays in view after the adoption", async () => {
    const c = await spawn(ROOT_KEY, { name: "maxtok", prompt: "TASK-MAXTOK" });
    const id = c.body.agentId as string; const sk = c.body.sessionKey as string;
    const first = await until("its result", () => reportsFor(id)[0]);
    expect(first.outcome.status).toBe("failed");
    await until("child free", () => !busy(sk));
    // A restart while it was still `running`.
    ctx.db.run("UPDATE subagents SET state = 'running', ended_at = NULL WHERE id = ?", [id]);
    const { resetTurnEndRegistry } = await import("../../server/providers/turn-end-registry");
    resetTurnEndRegistry();
    const native = await import("../../server/lib/native-subagents");
    await native.adoptNativeChildrenAtBoot({ waitMs: 200, pollMs: 50 });
    expect(rowOf(id)?.state).toBe("retired");
    expect(ctx.getTopicBySessionKey(sk)?.archived).toBe(false);
    expect(reportsFor(id)).toHaveLength(1);
  }, 30_000);
});
