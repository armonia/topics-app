/**
 * Native sub-agents on the REAL engine: the native provider and the whole
 * topics router (chat route, abort route) as the server runs them, with only
 * the network faked. Review 3 of PR 238 (05/10) found the fake chat route of
 * the older suites recording one end per turn where the engine records two
 * (the provider, then the route's finalize): the tests passed on the defect.
 * Every test here was a repro that pinned a defect, inverted.
 * @covers SUBAGENT-11, SUBAGENT-12, SUBAGENT-14, SUBAGENT-19, SUBAGENT-22
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "./helpers";
import { startFakeClaudeBridge, type FakeBridge } from "./helpers/fake-claude-bridge";
import type { SubAgentExitInfo } from "../../server/routes/subagent-exit";
import type { AppContext, Topic } from "../../server/types";

const ROOT = testTmpDir("subagent-native-engine");
const SOCKET_PATH = `${ROOT}/b.sock`;
const PROJECT = `${ROOT}/proj`;
const AGENTS_HOME = `${ROOT}/agents-home`;
const TOKEN = "subagent-native-engine-token";
const ROOT_KEY = "topic:e1e1e1e1";
const REAL_HOME = process.env.HOME;
const realFetch = globalThis.fetch;

let bridge: FakeBridge;
let ctx: AppContext;
let terminalRouter: (req: Request, url: URL, pathname: string, method: string) => Promise<Response | null> | Response | null;
let route: (req: Request, url: URL, pathname: string, method: string) => Promise<Response | null>;
const reports: SubAgentExitInfo[] = [];
/** Results the wake wrote as plain rows instead of a turn: `[parent chat, child id]`. */
const resultRows: Array<[string, string]> = [];
/** Background work the child chat's own process claims (a command). */
const busyBackground = new Set<string>();

// ── The network: the Messages API, answering at once or held on a marker ─────

/** Turns whose request carries one of these markers wait for their release (or their abort). */
const held = new Map<string, Array<() => void>>();
/** Every model request, by the markers it carried. */
const modelCalls: string[] = [];

function finalRound(text: string): string {
  return [
    { type: "message_start", message: { usage: { input_tokens: 10 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
  ].map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

function hold(marker: string): void { held.set(marker, []); }
function release(marker: string): void {
  const waiting = held.get(marker) ?? [];
  held.delete(marker);
  for (const go of waiting) go();
}

async function fakeNetwork(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const body = typeof init?.body === "string" ? init.body : "";
  modelCalls.push(body);
  const marker = [...held.keys()].find((m) => body.includes(m));
  if (marker) {
    await new Promise<void>((resolve, reject) => {
      held.get(marker)!.push(resolve);
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  }
  void input;
  return new Response(finalRound(`answer ${modelCalls.length}`), { status: 200 });
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
  ctx.projectStore.create({ name: "proj", slug: "proj-engine", path: PROJECT });

  // The engine, registered as the server registers it, and the whole topics router.
  const { registerProvider } = await import("../../server/providers");
  registerProvider({ type: "native" } as never);
  const { createTopicsRouter, reopenDepsFor } = await import("../../server/routes/topics");
  const topics = createTopicsRouter(ctx);
  route = async (req, url, pathname, method) => (await topics(req, url, pathname, method)) ?? null;

  const terminal = await import("../../server/routes/terminal");
  terminal.disconnectBridge();
  terminal._setPtyBridgeSocketPath(SOCKET_PATH);
  terminal._setAgentProfilesHome(AGENTS_HOME);
  terminal._setTerminalTrackerForTests(null);
  // The parent's wake as server.ts starts it, with its verdict.
  const { startSubagentWakes } = await import("../../server/services/subagent-wake");
  const { subAgentResultOf } = await import("../../server/routes/subagent-exit");
  const { runningTaskOwnsTopic, stoppedSubagentChat, wakeVerdict } = await import("../../server/lib/wake-adoption");
  const wake = startSubagentWakes({
    route, isBusy: busy,
    canWake: (sk) => {
      const t = ctx.getTopicBySessionKey(sk);
      return !t || wakeVerdict({ id: t.id, archived: t.archived }, (id) => runningTaskOwnsTopic(ctx.db, id), (id) => stoppedSubagentChat(ctx.db, id)) !== "adopt" ? "row" : "wake";
    },
    debounceMs: 50, pollMs: 50, endGraceMs: 500,
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

afterEach(() => { busyBackground.clear(); for (const m of [...held.keys()]) release(m); });

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

describe("native sub-agents on the real engine", () => {
  // Blocking 1: the engine records each end twice, and each end was a link in
  // the report chain: one wake turn, two results to the parent.
  test("one wake turn of a child is one result to its parent", async () => {
    hold("TASK-WAKE-ONCE");
    const c = await spawn(ROOT_KEY, { name: "wake-once", prompt: "TASK-WAKE-ONCE" });
    const id = c.body.agentId as string; const sk = c.body.sessionKey as string;
    // Something of its own will wake it: turn 1 leaves it running.
    busyBackground.add(sk);
    release("TASK-WAKE-ONCE");
    await until("turn 1 reported", () => reportsFor(id)[0]);
    expect(rowOf(id)?.state).toBe("running");
    // The wake: a turn the server starts on the child's chat by itself.
    const before = modelCalls.length;
    const url = new URL("http://localhost/api/chat");
    const resp = await route(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionKey: sk, messages: [{ role: "user", content: "<subagent-result>grandchild done</subagent-result>" }] }) }), url, "/api/chat", "POST");
    expect(resp?.status).toBe(200);
    const reader = resp!.body!.getReader();
    while (!(await reader.read()).done) { /* drain */ }
    busyBackground.delete(sk);
    await until("the wake turn reported", () => reportsFor(id)[1]);
    await sleep(1_500);
    const childCalls = modelCalls.slice(before).filter((b) => b.includes("grandchild done")).length;
    expect(childCalls).toBe(1);
    expect(reportsFor(id).map((r) => [r.turn, r.outcome.status])).toEqual([[1, "completed"], [2, "completed"]]);
    expect(reportsFor(id)[1]!.outcome.text).toMatch(/^answer \d+$/);
  }, 30_000);

  // Blocking 2: a grandchild's result queued for a busy child, the Stop on
  // the root: the child's chat is open, so the queued wake ran a turn on it.
  test("a result queued for a child before its Stop does not wake it after", async () => {
    hold("TASK-BUSY-CHILD");
    const c = await spawn(ROOT_KEY, { name: "busy-child", prompt: "TASK-BUSY-CHILD" });
    const cid = c.body.agentId as string; const childKey = c.body.sessionKey as string;
    await until("child turn open", () => busy(childKey));
    const g = await spawn(childKey, { name: "fast-grand", prompt: "TASK-FAST-GRAND" });
    const gid = g.body.agentId as string;
    await until("grand reported", () => reportsFor(gid)[0]);
    // Its result waits for the child's turn to end.
    await sleep(200);
    const usersBefore = userTurns(childKey);
    const { stopNativeChildrenOf } = await import("../../server/lib/native-subagents");
    await stopNativeChildrenOf(ROOT_KEY);
    expect(rowOf(cid)?.state).toBe("stopped");
    await until("child turn closed", () => !busy(childKey));
    await sleep(1_500);
    expect(userTurns(childKey) - usersBefore).toBe(0);
    // The result is not lost: it lands as a row in the child's chat.
    expect(resultRows).toContainEqual([childKey, gid]);
  }, 30_000);

  // Blocking 3: a child that reported and only waits on its grandchild, sent a
  // turn during the boot's minute, was told its turn was `lost`.
  test("a child only waiting, sent a turn during the boot's adoption: no false lost", async () => {
    hold("TASK-WAIT-CHILD");
    hold("TASK-SLOW-GRAND");
    const c = await spawn(ROOT_KEY, { name: "wait-child", prompt: "TASK-WAIT-CHILD" });
    const cid = c.body.agentId as string; const childKey = c.body.sessionKey as string;
    await until("child open", () => busy(childKey));
    const g = await spawn(childKey, { name: "slow-grand", prompt: "TASK-SLOW-GRAND" });
    await until("grand open", () => busy(g.body.sessionKey as string));
    release("TASK-WAIT-CHILD");
    await until("child turn 1", () => reportsFor(cid)[0]);
    expect(rowOf(cid)?.state).toBe("running");
    await sleep(1_200);
    // The restart: the turn-end registry is memory.
    const { resetTurnEndRegistry } = await import("../../server/providers/turn-end-registry");
    resetTurnEndRegistry();
    const native = await import("../../server/lib/native-subagents");
    const adoption = native.adoptNativeChildrenAtBoot({ waitMs: 3_000, pollMs: 50 });
    await sleep(100);
    const res = await call(`${agents(ROOT_KEY)}/${cid}/send`, "POST", { input: "carry on" });
    expect(res.status).toBe(200);
    await adoption;
    await until("child turn 2", () => reportsFor(cid)[1]);
    await sleep(800);
    expect(reportsFor(cid).map((r) => r.outcome.status)).toEqual(["completed", "completed"]);
  }, 30_000);

  // Point 4: the tree stop descended only through native nodes.
  test("a native grandchild under a CLI child stops with the tree", async () => {
    const c = await spawn(ROOT_KEY, { name: "cli-mid", prompt: "do the thing", runtime: "claude-code" });
    expect(c.body.runtime).toBe("claude-code");
    const cliId = c.body.agentId as string;
    hold("TASK-UNDER-CLI");
    const g = await spawn(cliId, { name: "native-under-cli", prompt: "TASK-UNDER-CLI" });
    expect(g.body.runtime).toBe("topics");
    const gid = g.body.agentId as string; const grandKey = g.body.sessionKey as string;
    await until("grand open", () => busy(grandKey));
    const { stopNativeChildrenOf } = await import("../../server/lib/native-subagents");
    await stopNativeChildrenOf(ROOT_KEY);
    await until("grand turn closed", () => !busy(grandKey));
    expect(rowOf(cliId)?.state).toBe("stopped");
    expect(rowOf(gid)?.state).toBe("stopped");
  }, 30_000);

  // Point 6: the Stop is for nodes at work. A parked CLI child (its turn over,
  // its PTY kept for a resume) is left alone; the tree under it is not.
  test("a parked CLI child keeps its PTY through the tree stop", async () => {
    const c = await spawn(ROOT_KEY, { name: "cli-parked", prompt: "do the thing", runtime: "claude-code" });
    const cliId = c.body.agentId as string;
    const { runtimeOf } = await import("../../server/lib/subagent-runtime");
    runtimeOf(cliId).phase = "finished";
    hold("TASK-UNDER-PARKED");
    const g = await spawn(cliId, { name: "under-parked", prompt: "TASK-UNDER-PARKED" });
    const gid = g.body.agentId as string;
    await until("grand open", () => busy(g.body.sessionKey as string));
    const { stopNativeChildrenOf } = await import("../../server/lib/native-subagents");
    await stopNativeChildrenOf(ROOT_KEY);
    expect(rowOf(gid)?.state).toBe("stopped");
    // Left alone: the stopper would have killed it, or closed its row.
    expect(rowOf(cliId)?.state).toBe("running");
    expect(bridge.received.some((m) => m.type === "kill" && (m as { id?: string }).id === cliId)).toBe(false);
  }, 30_000);

  // Point 5: «Send now» on a queued message aborts the parent's turn to send
  // the correction; it stopped every child with it, as a Stop does.
  test("«Send now» stops the parent's turn only; the person's Stop stops the tree", async () => {
    hold("TASK-KEEPS-WORKING");
    const c = await spawn(ROOT_KEY, { name: "keeps-working", prompt: "TASK-KEEPS-WORKING" });
    const cid = c.body.agentId as string; const childKey = c.body.sessionKey as string;
    await until("child turn open", () => busy(childKey));
    await until("the parent free", () => !busy(ROOT_KEY));
    hold("TASK-PARENT-TURN");
    const chatUrl = new URL("http://localhost/api/chat");
    const turn = await route(new Request(chatUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionKey: ROOT_KEY, messages: [{ role: "user", content: "TASK-PARENT-TURN" }] }) }), chatUrl, "/api/chat", "POST");
    expect(turn?.status).toBe(200);
    await until("the parent's turn open", () => busy(ROOT_KEY));
    // Sent by the client, as the client sends it: not a request the server built.
    const abort = (cause?: string) => {
      const url = new URL("http://localhost/api/chat/abort");
      return route(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionKey: ROOT_KEY, ...(cause ? { cause } : {}) }) }), url, url.pathname, "POST");
    };
    const { SEND_NOW_STOP_CAUSE } = await import("../../shared/types");
    expect((await abort(SEND_NOW_STOP_CAUSE))?.status).toBe(200);
    const reader = turn!.body!.getReader();
    while (!(await reader.read()).done) { /* drain */ }
    await until("the parent's turn closed", () => !busy(ROOT_KEY));
    await sleep(300);
    expect(rowOf(cid)?.state).toBe("running");
    expect(busy(childKey)).toBe(true);
    // The person's Stop: the parent has no turn left, the tree stops all the same.
    expect((await abort())?.status).toBe(200);
    expect(rowOf(cid)?.state).toBe("stopped");
    await until("child turn closed", () => !busy(childKey));
  }, 30_000);

  // Point 7: closed by the re-check (its work over, no wake turn), a child
  // whose last turn completed left the view like any other.
  test("a child closed by the re-check after a completed turn is archived", async () => {
    hold("TASK-RECHECK");
    const c = await spawn(ROOT_KEY, { name: "recheck", prompt: "TASK-RECHECK" });
    const id = c.body.agentId as string; const sk = c.body.sessionKey as string;
    busyBackground.add(sk);
    release("TASK-RECHECK");
    await until("turn 1 reported", () => reportsFor(id)[0]);
    expect(rowOf(id)?.state).toBe("running");
    expect(ctx.getTopicBySessionKey(sk)?.archived).toBe(false);
    busyBackground.delete(sk);
    await until("closed by the re-check", () => rowOf(id)?.state === "retired");
    expect(reportsFor(id)).toHaveLength(1);
    expect(ctx.getTopicBySessionKey(sk)?.archived).toBe(true);
  }, 30_000);
});
