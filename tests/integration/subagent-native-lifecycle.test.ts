/**
 * A native sub-agent's turn across what cuts it: the stale-stream sweep, a
 * graceful restart, a crash with a Stop during the boot, a send that loses
 * the race for the chat, a regeneration. On the REAL engine (the native
 * provider and the whole topics router) with only the network faked. Review 5
 * of PR 238 (05/10) pinned each defect with one of these repros; the
 * assertions are the behaviour the review asked for. The rule they hold: a
 * chat has one open turn, any end on it closes that turn, its outcome comes
 * from the end's cause, and the server's shutdown is no outcome.
 * @covers SUBAGENT-11, SUBAGENT-19, SUBAGENT-22
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "./helpers";
import { startFakeClaudeBridge, type FakeBridge } from "./helpers/fake-claude-bridge";
import type { SubAgentExitInfo } from "../../server/routes/subagent-exit";
import type { AppContext, Topic } from "../../server/types";

const ROOT = testTmpDir("subagent-native-lifecycle");
const SOCKET_PATH = `${ROOT}/b.sock`;
const PROJECT = `${ROOT}/proj`;
const AGENTS_HOME = `${ROOT}/agents-home`;
const TOKEN = "native-lifecycle-token";
const ROOT_KEY = "topic:e5e5e5e5";
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
let resumeReleased = false;
let loopCalls = 0;
let nativeDeps: import("../../server/lib/native-subagents").NativeSubagentDeps | null = null;
let routeDelay: { marker: string; ms: number } | null = null;

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
  if (body.includes("R5-TOOLTHENHANG")) {
    if (!body.includes("tool_result")) {
      return new Response(sse([
        { type: "message_start", message: { usage: { input_tokens: 10 } } },
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_r5_" + modelCalls, name: "bash", input: {} } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ command: "echo r5" }) } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 2 } },
      ]), { status: 200 });
    }
    if (!resumeReleased) await new Promise<void>((_, reject) => { init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))); });
  }
  if (body.includes("R5-LOOP")) {
    loopCalls++;
    if (loopCalls <= 2) {
      return new Response(sse([
        { type: "message_start", message: { usage: { input_tokens: 10 } } },
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_loop_" + loopCalls, name: "bash", input: {} } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ command: "echo loop" }) } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 2 } },
      ]), { status: 200 });
    }
  }
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
    if (pathname === "/api/chat" && routeDelay) {
      const body = await req.clone().text();
      if (body.includes(routeDelay.marker)) { const ms = routeDelay.ms; routeDelay = null; await new Promise((r) => setTimeout(r, ms)); }
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
  native.configureNativeSubagents(nativeDeps = {
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


/** One tick of the stale-stream sweep, wired as server.ts wires it, with the clock moved 11 minutes ahead (a frozen turn). */
async function staleSweep(): Promise<Map<string, string>> {
  const { sweepStaleStreams } = await import("../../server/lib/stale-stream-sweep");
  const { resolveSessionOwner, childAliveForSweep } = await import("../../server/providers");
  const { finalizeStaleRow } = await import("../../server/lib/closed-outside");
  const { recordTurnEnd } = await import("../../server/providers/turn-end-registry");
  const { cancelled } = await import("../../server/providers/stop-reason");
  return sweepStaleStreams({
    now: () => Date.now() + 11 * 60_000,
    timeoutMs: 3 * 60_000,
    activeStreams: ctx.activeStreams as never,
    rescued: new Set(), silence: new Map(),
    getMessageById: (id) => ctx.getMessageById(id) as never,
    humanHoldAgeMs: () => null,
    childAlive: (sk) => childAliveForSweep(sk),
    resyncStream: () => {}, cancelAsk: () => {},
    updateStreamActivity: (sk) => ctx.updateStreamActivity(sk),
    getTopicId: (sk) => ctx.getTopicBySessionKey(sk)?.id,
    abortProvider: (sk) => {
      const owner = resolveSessionOwner(sk) as { abort?: (sk: string, r: undefined, reason: string) => Promise<void>; unregisterStreamHandler?: (sk: string) => void } | null;
      owner?.abort?.(sk, undefined, "watchdog")?.catch(() => {});
      owner?.unregisterStreamHandler?.(sk);
    },
    endStream: (sk) => ctx.endStream(sk) as never,
    broadcast: () => {},
    finalizeMessage: (args) => finalizeStaleRow(ctx.db as never, args),
    recordTurnEnd: (sk) => recordTurnEnd(sk, cancelled("watchdog", "stale stream sweep")),
    warn: () => {}, info: () => {},
  }) as Map<string, string>;
}

describe("the stale-stream sweep closes a child's open turn", () => {
  test("R5-1 the sweep cuts a driven turn: one `stopped` result with its reason, the child stays in view", async () => {
    hold("TASK-R5-DRIVEN");
    const c = await spawn(ROOT_KEY, { name: "r5-driven", prompt: "TASK-R5-DRIVEN" });
    const id = c.body.agentId as string; const sk = c.body.sessionKey as string;
    await until("busy", () => busy(sk));
    await sleep(300);
    await staleSweep();
    await until("its result", () => reportsFor(id)[0], 15_000).catch(() => null);
    await sleep(1_500);
    expect(reportsFor(id).map((r) => [r.outcome.status, r.outcome.reason])).toEqual([["stopped", { code: "swept" }]]);
    // A cut turn did not complete: the child stays in view.
    expect(ctx.getTopicBySessionKey(sk)?.archived).toBe(false);
  }, 40_000);

  test("R5-2 the sweep cuts a person's turn in a retired child's chat: the parent hears it, the child is not left running", async () => {
    const c = await spawn(ROOT_KEY, { name: "r5-person", prompt: "r5 quick child" });
    const id = c.body.agentId as string; const sk = c.body.sessionKey as string;
    await until("turn 1", () => reportsFor(id)[0]);
    await until("free", () => !busy(sk) && rowOf(id)?.state === "retired");
    hold("R5-PERSON-HUNG");
    expect(await chatTurn(sk, "R5-PERSON-HUNG please go on")).toBe(200);
    await until("person busy", () => busy(sk));
    expect(rowOf(id)?.state).toBe("running");
    await sleep(300);
    await staleSweep();
    await until("free", () => !busy(sk));
    await sleep(5_000);
    const { subagentWakeOwed } = await import("../../server/lib/subagent-runtime");
    expect(subagentWakeOwed(ROOT_KEY)).toBe(false);
    expect(reportsFor(id).length).toBe(2);
    expect(rowOf(id)?.state).not.toBe("running");
  }, 40_000);
});

describe("a stopped child gets no turn from the machine", () => {
  test("R5-3 the resume sweep leaves a stopped child stopped, and nothing wakes the root after the Stop", async () => {
    hold("TASK-R5-ENGAGED");
    const c = await spawn(ROOT_KEY, { name: "r5-engaged", prompt: "TASK-R5-ENGAGED" });
    const id = c.body.agentId as string; const sk = c.body.sessionKey as string;
    await until("busy", () => busy(sk));
    const { markSubagentEngaged } = await import("../../server/lib/subagent-store");
    markSubagentEngaged(ctx.db as never, id); // the person is looking at it
    release("TASK-R5-ENGAGED");
    await until("turn 1", () => reportsFor(id)[0]);
    await until("retired", () => !busy(sk) && rowOf(id)?.state === "retired");
    // The person writes in it; the turn hangs and the stale sweep cuts it.
    expect(await chatTurn(sk, "R5-3-PERSON R5-TOOLTHENHANG keep going")).toBe(200);
    await until("person busy", () => busy(sk));
    await sleep(2_000);
    expect([...(await staleSweep()).values()]).toEqual(["finalized"]);
    await until("free", () => !busy(sk));
    resumeReleased = true;
    await sleep(1_500);
    // The sweep closed the person's turn (a stopped result, the child retired):
    // the root's Stop has no live child left, so the parent stops this one itself.
    expect(statusesOf(id)).toEqual([[1, "completed", false], [2, "stopped", false]]);
    const rootUsersBefore = userTurns(ROOT_KEY);
    expect(await abortChat(ROOT_KEY)).toBe(200);
    const { getSubagent } = await import("../../server/lib/subagent-store");
    const native = await import("../../server/lib/native-subagents");
    await native.stopNativeChild(getSubagent(ctx.db as never, id)!, { archive: false });
    expect(rowOf(id)?.state).toBe("stopped");
    // The resume sweep (nudged after every stale cut, and on its 5-minute clock).
    const { riprendiTurniInterrotti } = await import("../../server/lib/ripresa-boot");
    await riprendiTurniInterrotti({
      db: ctx.db as never,
      getTopicBySessionKey: (k) => ctx.getTopicBySessionKey(k) as never,
      defaultProvider: () => "topics",
      isStreaming: (k) => ctx.activeStreams.has(k),
      providerBusy: () => false,
      bootedAtMs: Date.now() - 3_600_000,
    }, route as never, { responseMs: 5_000, streamMs: 10_000 });
    await sleep(3_000);
    await until("child free", () => !busy(sk));
    await sleep(2_000);
    // The resume sent the stopped child nothing.
    expect(ctx.loadLocalMessages(sk).filter((m) => m.role === "user").map((m) => m.content.slice(0, 11))).toEqual(["TASK-R5-ENG", "R5-3-PERSON"]);
    expect(rowOf(id)?.state).toBe("stopped");
    expect(userTurns(ROOT_KEY) - rootUsersBefore).toBe(0);
  }, 60_000);
});

describe("a graceful restart is no outcome", () => {
  test("R5-4 a graceful restart mid child turn: nothing before the resume, one result after it", async () => {
    const c = await spawn(ROOT_KEY, { name: "r5-restart", prompt: "R5-TOOLTHENHANG restart child" });
    resumeReleased = false;
    const id = c.body.agentId as string; const sk = c.body.sessionKey as string;
    await until("busy", () => busy(sk));
    await sleep(1_500);
    const { tryGetProvider } = await import("../../server/providers");
    // What gracefulShutdown does: stop() on every provider, then a 3.5 s window before closeDatabase().
    (tryGetProvider("topics") as { stop(): void }).stop();
    await sleep(3_500);
    // Within the shutdown window: no result, the child still running, nothing written down.
    const { lastReportedTurnStatus } = await import("../../server/lib/subagent-store");
    expect(reportsFor(id)).toHaveLength(0);
    expect(rowOf(id)?.state).toBe("running");
    expect(lastReportedTurnStatus(ctx.db as never, id)).toBeNull();
    // The boot: a fresh engine, then the resume sweep as server.ts chains it.
    const { registerProvider, removeProvider } = await import("../../server/providers");
    removeProvider("topics");
    registerProvider({ type: "native" } as never);
    resumeReleased = true;
    const { resetTurnEndRegistry } = await import("../../server/providers/turn-end-registry");
    resetTurnEndRegistry();
    const native = await import("../../server/lib/native-subagents");
    const adoption = native.adoptNativeChildrenAtBoot({ waitMs: 3_000, pollMs: 50 });
    const { riprendiTurniInterrotti } = await import("../../server/lib/ripresa-boot");
    await riprendiTurniInterrotti({
      db: ctx.db as never,
      getTopicBySessionKey: (k) => ctx.getTopicBySessionKey(k) as never,
      defaultProvider: () => "topics",
      isStreaming: (k) => ctx.activeStreams.has(k),
      providerBusy: () => false,
      bootedAtMs: Date.now(),
    }, route as never, { responseMs: 5_000, streamMs: 15_000 });
    await adoption;
    await until("the resumed turn's result", () => reportsFor(id)[0], 15_000);
    await sleep(3_000);
    // One result, the resumed turn's own: the cut was never said.
    expect(reportsFor(id).map((r) => [r.turn, r.outcome.status])).toEqual([[1, "completed"]]);
  }, 60_000);
});

describe("a normal chat on the engine is untouched", () => {
  test("R5-5 a normal chat on the engine: a person's turn, a command's wake and a Stop all close", async () => {
    const NORMAL = "topic:d7d7d7d7";
    topic(NORMAL);
    expect(await chatTurn(NORMAL, "hello normal")).toBe(200);
    await until("closed", () => !busy(NORMAL));
    await sleep(200);
    const r1 = ctx.loadLocalMessages(NORMAL);
    expect(r1.at(-1)?.partial).toBeFalsy();
    // A process-exit wake, the body process-exit-wake.ts posts.
    const url = new URL("http://localhost/api/chat");
    const res = await route(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionKey: NORMAL, messages: [{ role: "user", content: "[Topics] command finished: exit 0" }], processExit: { processId: "p1", exitCode: 0, label: "x" } }) }), url, "/api/chat", "POST");
    if (res?.body) { const r = res.body.getReader(); while (!(await r.read()).done) { /* drain */ } }
    await until("wake closed", () => !busy(NORMAL));
    // A Stop mid-turn.
    hold("R5-NORMAL-STOP");
    expect(await chatTurn(NORMAL, "R5-NORMAL-STOP")).toBe(200);
    await until("busy", () => busy(NORMAL));
    expect(await abortChat(NORMAL)).toBe(200);
    await until("stopped closed", () => !busy(NORMAL));
    held.delete("R5-NORMAL-STOP");
    expect(await chatTurn(NORMAL, "after the stop")).toBe(200);
    await until("closed again", () => !busy(NORMAL));
    expect(ctx.loadLocalMessages(NORMAL).at(-1)?.partial).toBeFalsy();
  }, 30_000);
});

describe("a long child turn is one result", () => {
  test("R5-6 a child turn of several tool rounds is one result", async () => {
    const c = await spawn(ROOT_KEY, { name: "r5-budget", prompt: "R5-LOOP do many steps" });
    const id = c.body.agentId as string; const sk = c.body.sessionKey as string;
    await until("first result", () => reportsFor(id)[0], 15_000);
    await sleep(4_000);
    await until("free", () => !busy(sk));
    await sleep(1_000);
    expect(reportsFor(id)).toHaveLength(1);
  }, 40_000);
});

describe("the driven turn is the one it sent", () => {
  test("R5-7 send_to_agent loses the race for the chat: a 409 to the parent, the other turn reported as itself", async () => {
    const c = await spawn(ROOT_KEY, { name: "r5-race", prompt: "r5 race child" });
    const id = c.body.agentId as string; const sk = c.body.sessionKey as string;
    await until("turn 1", () => reportsFor(id)[0]);
    await until("retired", () => !busy(sk) && rowOf(id)?.state === "retired");
    // The driven POST takes a beat to reach the gate; another turn gets there first.
    routeDelay = { marker: "R5-SEND-FOLLOWUP", ms: 300 };
    const sending = call(`${agents(ROOT_KEY)}/${id}/send`, "POST", { input: "R5-SEND-FOLLOWUP do the second part" });
    await sleep(50);
    hold("R5-OTHER");
    expect(await chatTurn(sk, "R5-OTHER someone else's turn")).toBe(200);
    // The send was not sent: the parent hears it from its own call, never an ok.
    const sent = await sending;
    expect(sent.status).toBe(409);
    release("R5-OTHER");
    await until("free", () => !busy(sk));
    await until("the other turn's result", () => reportsFor(id)[1]);
    await sleep(1_000);
    const rows = ctx.loadLocalMessages(sk);
    expect(rows.some((m) => m.role === "user" && m.content.startsWith("R5-SEND-FOLLOWUP"))).toBe(false);
    // The turn that got there first is not taken for the driven one: it is reported as itself.
    const otherAt = rows.findIndex((m) => m.role === "user" && m.content.startsWith("R5-OTHER"));
    const otherAnswer = rows.slice(otherAt + 1).find((m) => m.role === "assistant")!.content;
    expect(reportsFor(id).map((r) => [r.turn, r.outcome.status, r.outcome.text])).toEqual([[1, "completed", reportsFor(id)[0]!.outcome.text], [2, "completed", otherAnswer]]);
  }, 40_000);
});

describe("a child's chat is not regenerated", () => {
  test("R5-9 editing or regenerating in a child's chat is refused: it would be a turn its parent never hears of", async () => {
    const c = await spawn(ROOT_KEY, { name: "r5-regen", prompt: "r5 regen child" });
    const id = c.body.agentId as string; const sk = c.body.sessionKey as string;
    await until("turn 1", () => reportsFor(id)[0]);
    await until("free", () => !busy(sk));
    const rowsBefore = ctx.loadLocalMessages(sk).length;
    const userRow = ctx.loadLocalMessages(sk).find((m) => m.role === "user")!;
    const answerRow = ctx.loadLocalMessages(sk).find((m) => m.role === "assistant")!;
    for (const [path, body] of [[`/api/messages/${answerRow.id}/regenerate`, {}], [`/api/messages/${userRow.id}/edit`, { content: "rewritten" }]] as const) {
      const url = new URL(`http://localhost${path}`);
      const res = await route(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), url, url.pathname, "POST");
      expect(res?.status).toBe(409);
    }
    expect(ctx.loadLocalMessages(sk)).toHaveLength(rowsBefore);
    expect(reportsFor(id)).toHaveLength(1);
  }, 30_000);
});

describe("a crash, a Stop during the boot, then the resume", () => {
  test("R5-8 a crash mid person's turn, the root's Stop during the boot: the resume sends the stopped child nothing", async () => {
    const native = await import("../../server/lib/native-subagents");
    hold("TASK-R5-8");
    const c = await spawn(ROOT_KEY, { name: "r5-crash", prompt: "TASK-R5-8" });
    const id = c.body.agentId as string; const sk = c.body.sessionKey as string;
    await until("busy", () => busy(sk));
    const { markSubagentEngaged } = await import("../../server/lib/subagent-store");
    markSubagentEngaged(ctx.db as never, id);
    release("TASK-R5-8");
    await until("turn 1", () => reportsFor(id)[0]);
    await until("retired", () => !busy(sk) && rowOf(id)?.state === "retired");
    resumeReleased = false;
    expect(await chatTurn(sk, "R5-TOOLTHENHANG person keeps it going")).toBe(200);
    await until("person busy", () => busy(sk));
    await sleep(1_500);
    expect(rowOf(id)?.state).toBe("running");
    // The crash: nothing of this process reports the cut turn; the row carries the restart's verdict.
    native.configureNativeSubagents(null);
    const { tryGetProvider, registerProvider, removeProvider } = await import("../../server/providers");
    (tryGetProvider("topics") as { stop(): void }).stop();
    await until("cut", () => !busy(sk));
    await sleep(500);
    removeProvider("topics");
    registerProvider({ type: "native" } as never);
    const { resetTurnEndRegistry } = await import("../../server/providers/turn-end-registry");
    resetTurnEndRegistry();
    native.configureNativeSubagents(nativeDeps!);
    resumeReleased = true;
    // The boot: the adoption starts, the person stops the root, then the resume sweep runs.
    const adoption = native.adoptNativeChildrenAtBoot({ waitMs: 2_000, pollMs: 50 });
    await sleep(100);
    const rootUsersBefore = userTurns(ROOT_KEY);
    expect(await abortChat(ROOT_KEY)).toBe(200);
    const { riprendiTurniInterrotti } = await import("../../server/lib/ripresa-boot");
    await riprendiTurniInterrotti({
      db: ctx.db as never,
      getTopicBySessionKey: (k) => ctx.getTopicBySessionKey(k) as never,
      defaultProvider: () => "topics",
      isStreaming: (k) => ctx.activeStreams.has(k),
      providerBusy: () => false,
      bootedAtMs: Date.now(),
    }, route as never, { responseMs: 5_000, streamMs: 15_000 });
    await adoption;
    await sleep(3_000);
    await until("child free", () => !busy(sk));
    await sleep(1_500);
    expect(rowOf(id)?.state).toBe("stopped");
    expect(userTurns(ROOT_KEY) - rootUsersBefore).toBe(0);
  }, 60_000);
});
