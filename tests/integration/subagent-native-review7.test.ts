/**
 * A native sub-agent's turn is one its chat really opened, never a user row:
 * a row that opened no turn owes no `lost`; a chat command in a child's chat
 * is its prompt, whoever sends it, the resume too; a resume the chat route
 * refuses for good (no engine) is the cut turn's one `failed`. On the REAL
 * engine (the native provider and the whole topics router) with only the
 * network faked. Review 7 of PR 238 (05/10) pinned each defect with one of
 * these repros; the assertions are the behaviour it asked for.
 * @covers SUBAGENT-11, SUBAGENT-19, SUBAGENT-22
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "./helpers";
import { startFakeClaudeBridge, type FakeBridge } from "./helpers/fake-claude-bridge";
import type { SubAgentExitInfo } from "../../server/routes/subagent-exit";
import type { AppContext, Topic } from "../../server/types";

const ROOT = testTmpDir("review7-repro");
const SOCKET_PATH = `${ROOT}/b.sock`;
const PROJECT = `${ROOT}/proj`;
const AGENTS_HOME = `${ROOT}/agents-home`;
const TOKEN = "native-lifecycle-token";
const ROOT_KEY = "topic:e7e7e7e7";
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
let selfAnswer: string | null = null;

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
  ctx.projectStore.create({ name: "proj", slug: "proj-review7", path: PROJECT });

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
    if (pathname === "/api/chat" && selfAnswer) {
      const body = await req.clone().text();
      // A chat route that answers on its own and opens no turn (a command it handled).
      if (body.includes(selfAnswer)) return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
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
    cutTurnResumable: async (sk) => { const { cutTurnResumable } = await import("../../server/lib/ripresa-boot"); return cutTurnResumable(resumeCtx(), sk); },
  });
  await until("the reconcile list", () => bridge.received.some((m) => m.type === "list"), 5_000);
}, 30_000);

afterEach(async () => {
  busyBackground.clear();
  slowAbortMs = 0;
  abortHook = null;
  selfAnswer = null;
  { const { clearProviderHold } = await import("../../server/lib/provider-hold"); clearProviderHold(); }
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


/** The resume's context, wired as server.ts wires it. */
function resumeCtx(): import("../../server/lib/ripresa-boot").CtxRipresa {
  return {
    db: ctx.db as never,
    getTopicBySessionKey: (k) => ctx.getTopicBySessionKey(k) as never,
    defaultProvider: () => "topics",
    isStreaming: (k) => ctx.activeStreams.has(k),
    providerBusy: () => false,
    bootedAtMs: Date.now() - 1_000,
    abandonCut: (sk, failure) => { void (async () => { const { abandonCutTurn } = await import("../../server/lib/native-subagents"); abandonCutTurn(sk, failure); })(); },
  };
}

/** One tick of the resume sweep (boot or periodic). */
async function resumeSweep(): Promise<void> {
  const { riprendiTurniInterrotti } = await import("../../server/lib/ripresa-boot");
  await riprendiTurniInterrotti(resumeCtx(), route as never, { responseMs: 5_000, streamMs: 15_000 });
}

/** A POST on /api/chat as an outside caller sends it (`headers`), drained. */
async function postChat(sessionKey: string, content: string, opts: { headers?: Record<string, string>; fromAgent?: boolean; internal?: boolean } = {}): Promise<{ status: number; body: string }> {
  const url = new URL("http://localhost/api/chat");
  const init = { method: "POST", headers: { "Content-Type": "application/json", ...opts.headers }, body: JSON.stringify({ sessionKey, messages: [{ role: "user", content }], ...(opts.fromAgent ? { fromAgent: true } : {}) }) };
  const { internalRequest } = await import("../../server/lib/abort-cause");
  const res = await route(opts.internal ? internalRequest(url, init) : new Request(url, init), url, "/api/chat", "POST");
  let body = "";
  if (res && !res.ok) body = await res.text();
  else if (res?.body) { const r = res.body.getReader(); while (!(await r.read()).done) { /* drain */ } }
  return { status: res?.status ?? 0, body };
}

/**
 * A child mid-turn, cut by a graceful restart; the new process boots while a
 * provider hold walls the resume, and the adoption's minute (2 s here) passes.
 */
async function restartUnderHold(name: string): Promise<{ id: string; sk: string }> {
  resumeReleased = false;
  const c = await spawn(ROOT_KEY, { name, prompt: `R5-TOOLTHENHANG ${name} restart child` });
  const id = c.body.agentId as string; const sk = c.body.sessionKey as string;
  await until("busy", () => busy(sk));
  await sleep(1_500);
  const providers = await import("../../server/providers");
  // gracefulShutdown: stop() on every provider.
  (providers.tryGetProvider("topics") as { stop(): void }).stop();
  await until("cut", () => !busy(sk));
  await sleep(1_000);
  expect(reportsFor(id)).toHaveLength(0);
  // The process is gone: its memory with it.
  const native = await import("../../server/lib/native-subagents");
  native._resetNativeSubagents();
  native.configureNativeSubagents(nativeDeps!);
  providers.removeProvider("topics");
  providers.registerProvider({ type: "native" } as never);
  const { resetTurnEndRegistry } = await import("../../server/providers/turn-end-registry");
  resetTurnEndRegistry();
  resumeReleased = true;
  const ph = await import("../../server/lib/provider-hold");
  ph.setProviderHold({ untilMs: Date.now() + 10 * 60_000, window: "api-down", reason: "API down (review 6)" });
  const adoption = native.adoptNativeChildrenAtBoot({ waitMs: 2_000, pollMs: 50 });
  await resumeSweep(); // the boot's sweep: deferred by the hold
  await adoption;
  await sleep(500);
  return { id, sk };
}

/**
 * A retired child, then a turn of `text` sent with send_to_agent and held on
 * `marker`, cut by a graceful restart; the new process boots with no hold.
 * The chat's rows are aged three minutes, as after a real restart.
 */
async function restartMidSend(name: string, marker: string, text: string): Promise<{ id: string; sk: string }> {
  const c = await spawn(ROOT_KEY, { name, prompt: `${name} quick first turn` });
  const id = c.body.agentId as string; const sk = c.body.sessionKey as string;
  await until("turn 1", () => reportsFor(id)[0]);
  await until("retired", () => !busy(sk) && rowOf(id)?.state === "retired");
  hold(marker);
  const res = await call(`${agents(ROOT_KEY)}/${id}/send`, "POST", { input: text });
  expect(res.status).toBe(200);
  await until("busy", () => busy(sk));
  await sleep(500);
  const providers = await import("../../server/providers");
  (providers.tryGetProvider("topics") as { stop(): void }).stop();
  await until("cut", () => !busy(sk));
  await sleep(1_000);
  expect(reportsFor(id)).toHaveLength(1);
  const native = await import("../../server/lib/native-subagents");
  native._resetNativeSubagents();
  native.configureNativeSubagents(nativeDeps!);
  providers.removeProvider("topics");
  providers.registerProvider({ type: "native" } as never);
  const { resetTurnEndRegistry } = await import("../../server/providers/turn-end-registry");
  resetTurnEndRegistry();
  release(marker);
  const past = new Date(Date.now() - 3 * 60_000).toISOString();
  ctx.db.run("UPDATE messages SET timestamp = ? WHERE session_key = ?", [past, sk]);
  return { id, sk };
}

describe("a turn is one the chat opened, never a user row", () => {
  test("a `/project` prompt cut by a restart is resent as the child's prompt, never run as a chat command", async () => {
    const { id, sk } = await restartMidSend("rv7-r1", "R7B3HOLD", "/project list R7B3HOLD then fix the failing test");
    const { adoptNativeChildrenAtBoot } = await import("../../server/lib/native-subagents");
    const adoption = adoptNativeChildrenAtBoot({ waitMs: 2_000, pollMs: 50 });
    await resumeSweep();
    await adoption;
    await until("turn 2", () => reportsFor(id)[1], 15_000);
    await until("free", () => !busy(sk));
    await sleep(1_500);
    expect(ctx.loadLocalMessages(sk).some((m) => m.role === "assistant" && m.content.includes("Current project"))).toBe(false);
    expect(statusesOf(id)).toEqual([[1, "completed", false], [2, "completed", false]]);
  }, 60_000);

  test("a `/project open <dir>` prompt cut by a restart leaves the child's chat bound where it was", async () => {
    const other = join(ROOT, "R7OPENHOLD");
    fs.mkdirSync(other, { recursive: true });
    const { id, sk } = await restartMidSend("rv7-r1b", "R7OPENHOLD", `/project open ${other}`);
    const before = ctx.getTopicBySessionKey(sk)?.projectPath;
    const { adoptNativeChildrenAtBoot } = await import("../../server/lib/native-subagents");
    const adoption = adoptNativeChildrenAtBoot({ waitMs: 2_000, pollMs: 50 });
    await resumeSweep();
    await adoption;
    await until("turn 2", () => reportsFor(id)[1], 15_000);
    await sleep(1_000);
    expect(ctx.getTopicBySessionKey(sk)?.projectPath).toBe(before);
  }, 60_000);

  test("a person's `/project` in a child's chat is the child's prompt: a turn, its own result", async () => {
    const c = await spawn(ROOT_KEY, { name: "rv7-r2p", prompt: "rv7 r2p quick child" });
    const id = c.body.agentId as string; const sk = c.body.sessionKey as string;
    await until("turn 1", () => reportsFor(id)[0]);
    await until("retired", () => !busy(sk) && rowOf(id)?.state === "retired");
    expect((await postChat(sk, "/project list")).status).toBe(200);
    await until("turn 2", () => reportsFor(id)[1]);
    await until("retired again", () => !busy(sk) && rowOf(id)?.state === "retired");
    expect(statusesOf(id).map(([, s]) => s)).toEqual(["completed", "completed"]);
    expect(ctx.loadLocalMessages(sk).some((m) => m.content.includes("Current project"))).toBe(false);
  }, 30_000);

  test("a user row that opened no turn, then send_to_agent: no `lost` for a turn that never was", async () => {
    const c = await spawn(ROOT_KEY, { name: "rv7-r2", prompt: "rv7 r2 quick child" });
    const id = c.body.agentId as string; const sk = c.body.sessionKey as string;
    await until("turn 1", () => reportsFor(id)[0]);
    await until("retired", () => !busy(sk) && rowOf(id)?.state === "retired");
    // Rows the route wrote without a stream (a request cut before its turn opened).
    ctx.appendLocalMessage(sk, "user", "a message that opened no turn");
    ctx.appendLocalMessage(sk, "assistant", "an answer the route wrote by itself");
    const res = await call(`${agents(ROOT_KEY)}/${id}/send`, "POST", { input: "rv7 r2 next work" });
    expect(res.status).toBe(200);
    await until("its next result", () => reportsFor(id).length >= 2);
    await until("free", () => !busy(sk));
    await sleep(1_500);
    expect(statusesOf(id).map(([, s]) => s)).toEqual(["completed", "completed"]);
  }, 30_000);

  test("a child waiting on its own work, a user row that opened no turn, the periodic resume: no `lost`", async () => {
    const c = await spawn(ROOT_KEY, { name: "rv7-r3", prompt: "rv7 r3 quick child" });
    const id = c.body.agentId as string; const sk = c.body.sessionKey as string;
    // Its own background work: still running after its turn.
    busyBackground.add(sk);
    await until("turn 1", () => reportsFor(id)[0]);
    await until("free", () => !busy(sk));
    await sleep(500);
    expect(rowOf(id)?.state).toBe("running");
    ctx.appendLocalMessage(sk, "user", "a message that opened no turn");
    ctx.appendLocalMessage(sk, "assistant", "an answer the route wrote by itself");
    await resumeSweep();
    await sleep(1_500);
    expect(statusesOf(id).map(([, s]) => s)).toEqual(["completed"]);
  }, 30_000);

  test("the sweep cuts the turn of a child that waits on its own work (`swept`): the resume does not send it again", async () => {
    resumeReleased = false;
    const c = await spawn(ROOT_KEY, { name: "rv7-r4", prompt: "R5-TOOLTHENHANG rv7-r4 child works with a tool, then goes silent" });
    const id = c.body.agentId as string; const sk = c.body.sessionKey as string;
    // A command of its own still running: after its turn it waits for it.
    busyBackground.add(sk);
    await until("busy", () => busy(sk));
    await sleep(2_000);
    await staleSweep();
    await until("its result", () => reportsFor(id)[0], 15_000);
    await sleep(1_500);
    expect(rowOf(id)?.state).toBe("running");
    resumeReleased = true;
    const past = new Date(Date.now() - 3 * 60_000).toISOString();
    ctx.db.run("UPDATE messages SET timestamp = ? WHERE session_key = ?", [past, sk]);
    await resumeSweep();
    await sleep(500);
    await until("child free", () => !busy(sk));
    await sleep(1_500);
    expect(statusesOf(id)).toEqual([[1, "stopped", false]]);
    expect(userTurns(sk)).toBe(1);
  }, 40_000);
});

describe("a resume the chat route refuses for good", () => {
  test("DELETE /api/providers/topics while a cut turn waits for the resume: one `failed`, the engine removed", async () => {
    const { id } = await restartUnderHold("rv7-r5");
    expect(reportsFor(id)).toHaveLength(0);
    const { createProvidersRouter } = await import("../../server/routes/providers");
    const url = new URL("http://localhost/api/providers/topics");
    const res = await createProvidersRouter(ctx)(new Request(url, { method: "DELETE" }), url, url.pathname, "DELETE");
    expect(res?.status).toBe(200);
    try {
      await until("its result", () => reportsFor(id)[0], 10_000);
      await sleep(1_000);
      expect(reportsFor(id).map((r) => r.outcome)).toEqual([expect.objectContaining({ status: "failed", reason: { code: "api-error", detail: "error: the Topics engine was removed" } })]);
      expect(rowOf(id)?.state).not.toBe("running");
    } finally {
      const { registerProvider } = await import("../../server/providers");
      registerProvider({ type: "native" } as never);
    }
  }, 60_000);

  test("the engine disconnected while a cut turn waits for the resume: the refused resend is one `failed`", async () => {
    const { id, sk } = await restartUnderHold("rv7-r5b");
    expect(reportsFor(id)).toHaveLength(0);
    const providers = await import("../../server/providers");
    // Stopped, not removed: still registered, no longer connected.
    (providers.tryGetProvider("topics") as { stop(): void }).stop();
    try {
      { const { clearProviderHold } = await import("../../server/lib/provider-hold"); clearProviderHold(); }
      await resumeSweep();
      await until("its result", () => reportsFor(id)[0], 10_000);
      await resumeSweep();
      await sleep(1_000);
      expect(reportsFor(id).map((r) => r.outcome.status)).toEqual(["failed"]);
      expect(JSON.stringify(reportsFor(id)[0]!.outcome.reason)).toContain("the resume was refused");
      expect(rowOf(id)?.state).not.toBe("running");
      expect(busy(sk)).toBe(false);
    } finally {
      providers.removeProvider("topics");
      providers.registerProvider({ type: "native" } as never);
    }
  }, 60_000);
});
