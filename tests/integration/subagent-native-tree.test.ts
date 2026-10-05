/**
 * A native child is the middle of a tree: it delegates, waits, is woken, is
 * stopped with its grandchildren, is resumed, and survives restarts. Review 2
 * of PR 238 (05/10) found each of these broken; every test here was a repro
 * that pinned the defect, inverted. The real terminal router and test
 * database; the chat route is a fake that, like the real one, refuses a
 * second turn on a busy session with 409.
 * @covers SUBAGENT-11, SUBAGENT-14, SUBAGENT-18, SUBAGENT-19, SUBAGENT-21, SUBAGENT-22
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "./helpers";
import { startFakeClaudeBridge, type FakeBridge } from "./helpers/fake-claude-bridge";
import type { SubAgentExitInfo } from "../../server/routes/subagent-exit";
import type { AppContext, Topic } from "../../server/types";

const ROOT = testTmpDir("subagent-native-tree");
const SOCKET_PATH = `${ROOT}/b.sock`;
const PROJECT = `${ROOT}/proj`;
const HOME = `${ROOT}/home`;
const TOKEN = "subagent-native-tree-token";
const PARENT = "topic:7c1e0a55";
const ROOT2 = "topic:7c1e0a66";

let bridge: FakeBridge;
let ctx: AppContext;
let router: (req: Request, url: URL, pathname: string, method: string) => Promise<Response | null> | Response | null;
const reports: SubAgentExitInfo[] = [];
const open = new Map<string, () => void>();
/** How a held turn is cut by a Stop: its stream closes with nothing more written. */
const cut = new Map<string, () => void>();
let mode: "answer" | "hold" = "answer";
let route409 = 0;
/** Background work the child chat's own process claims (a command, a CLI task). */
const busyBackground = new Set<string>();

async function fakeChatRoute(req: Request, _url: URL, pathname: string): Promise<Response | null> {
  const { recordTurnEnd } = await import("../../server/providers/turn-end-registry");
  const body = await req.json() as { sessionKey: string; messages?: Array<{ content: string }> };
  const sessionKey = body.sessionKey;
  if (pathname === "/api/chat/abort") {
    const stop = cut.get(sessionKey);
    if (!stop) return Response.json({ ok: false, reason: "no_active_stream" });
    recordTurnEnd(sessionKey, { end: "cancelled", cause: "user" });
    stop();
    return Response.json({ ok: true });
  }
  if (pathname !== "/api/chat") return null;
  if (open.has(sessionKey)) { route409++; return Response.json({ code: "stream_in_flight", error: "busy" }, { status: 409 }); }
  const text = body.messages?.at(-1)?.content ?? "";
  ctx.appendLocalMessage(sessionKey, "user", text);
  const holding = mode === "hold";
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const finish = () => { open.delete(sessionKey); cut.delete(sessionKey); try { controller.close(); } catch { /* already closed */ } };
      cut.set(sessionKey, finish);
      if (holding) {
        open.set(sessionKey, () => {
          ctx.appendLocalMessage(sessionKey, "assistant", `done: ${text}`);
          recordTurnEnd(sessionKey, { end: "end_turn" });
          finish();
        });
        return;
      }
      open.set(sessionKey, finish);
      ctx.appendLocalMessage(sessionKey, "assistant", `done: ${text}`);
      recordTurnEnd(sessionKey, { end: "end_turn" });
      queueMicrotask(finish);
    },
    cancel() { open.delete(sessionKey); cut.delete(sessionKey); },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

async function call(path: string, method: string, body?: object): Promise<Response> {
  const url = new URL(`http://h${path}`);
  const res = await router(new Request(url, { method, headers: { "content-type": "application/json", "x-gateway-token": TOKEN }, body: body ? JSON.stringify(body) : undefined }), url, url.pathname, method);
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
const rowOf = (id: string) => ctx.db.query("SELECT state, runtime, session_key, turns_reported FROM subagents WHERE id = ?").get(id) as { state: string; runtime: string; session_key: string | null; turns_reported: number } | null;
async function spawn(parent: string, body: Record<string, unknown>) {
  const res = await call(`${agents(parent)}/spawn`, "POST", { prompt: "do the thing", ...body });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}
function topic(sessionKey: string): void {
  const now = new Date().toISOString();
  ctx.saveSingleTopic({ id: `${sessionKey.slice(6)}-0000-4000-8000-000000000001`, name: sessionKey, slug: sessionKey.slice(-6), parentId: null, links: [], sessionKey, color: "#aabbcc", icon: "chat", createdAt: now, updatedAt: now, archived: false, projectPath: PROJECT } as Topic);
}
/** A turn the server starts on the chat by itself (a wake), drained to its end. */
async function wakeTurn(sk: string, text: string) {
  const url = new URL("http://localhost/api/chat");
  const prev = mode; mode = "answer";
  const r = await fakeChatRoute(new Request(url, { method: "POST", body: JSON.stringify({ sessionKey: sk, messages: [{ content: text }] }) }), url, "/api/chat");
  mode = prev;
  const reader = r!.body!.getReader();
  while (!(await reader.read()).done) { /* drain */ }
}

let archiveDeps: import("../../server/services/archive-topic").ArchiveTopicDeps;

beforeAll(async () => {
  setupTestDataDir(join(ROOT, "data"));
  fs.mkdirSync(PROJECT, { recursive: true });
  fs.mkdirSync(join(HOME, ".claude", "agents"), { recursive: true });
  delete process.env.TOPICS_DISABLE_PTY_BRIDGE;
  delete process.env.TOPICS_EMBEDDED;
  process.env.GATEWAY_TOKEN = TOKEN;
  process.env.CLAUDE_BIN = "/bin/echo";
  { const { _resetClaudeBinCache } = await import("../../server/lib/claude-bin"); _resetClaudeBinCache(); }
  bridge = await startFakeClaudeBridge(ROOT, SOCKET_PATH);
  ctx = await createTestAppContext();
  topic(PARENT); topic(ROOT2);
  const terminal = await import("../../server/routes/terminal");
  terminal.disconnectBridge();
  terminal._setPtyBridgeSocketPath(SOCKET_PATH);
  terminal._setAgentProfilesHome(HOME);
  terminal._setTerminalTrackerForTests(null);
  terminal.setSubAgentExitHandler((info) => { reports.push(info); info.settle?.(); });
  router = terminal.createTerminalRouter(ctx) as typeof router;
  const { archiveTopicFully, reopenTopicFully } = await import("../../server/services/archive-topic");
  const { recordRetirement } = await import("../../server/services/retirement");
  const { reopenDepsFor } = await import("../../server/routes/topics");
  archiveDeps = {
    getTopicById: ctx.getTopicById, saveSingleTopic: ctx.saveSingleTopic, loadUnread: ctx.loadUnread,
    saveUnreadEntries: ctx.saveUnreadEntries, broadcastToAll: () => {}, purgeFromUiState: () => ({ ok: true }),
    recordRetirement: (id, at) => recordRetirement(ctx.db, "topic", id, at, "archive"),
  };
  const native = await import("../../server/lib/native-subagents");
  // As server.ts wires them.
  native.configureNativeSubagents({
    route: fakeChatRoute,
    isBusy: (sk) => open.has(sk),
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

afterEach(() => { mode = "answer"; busyBackground.clear(); for (const c of [...open.values()]) c(); });

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
  bridge?.cleanup();
  delete process.env.CLAUDE_BIN;
  delete process.env.GATEWAY_TOKEN;
  { const { _resetClaudeBinCache } = await import("../../server/lib/claude-bin"); _resetClaudeBinCache(); }
  await cleanupTestDataDir(ROOT);
});

describe("resume, wake and restart of a child in the middle of a tree", () => {
  // Review 2, A: the reopen cleared only the flag; the retirement fact stayed,
  // and the next boot's reconcile archived the child under its live turn.
  test("a resumed child is reopened through the unarchive's door: the boot reconcile leaves it open", async () => {
    const { body } = await spawn(PARENT, { name: "rearch" });
    const id = body.agentId as string; const sk = body.sessionKey as string;
    await until("turn 1", () => reportsFor(id)[0]);
    expect(ctx.getTopicBySessionKey(sk)?.archived).toBe(true);
    const { isRetired, reconcile } = await import("../../server/services/retirement");
    expect(isRetired(ctx.db, "topic", id)).toBe(true);
    mode = "hold";
    const res = await call(`${agents(PARENT)}/${id}/send`, "POST", { input: "turn 2, delegate" });
    expect(res.status).toBe(200);
    await until("turn 2 open", () => open.has(sk));
    expect(ctx.getTopicBySessionKey(sk)?.archived).toBe(false);
    expect(isRetired(ctx.db, "topic", id)).toBe(false);
    const { archiveTopicFully } = await import("../../server/services/archive-topic");
    reconcile(ctx.db, { archiveTopic: (tid) => { archiveTopicFully(archiveDeps, tid); }, retireTerminal: () => {} });
    const t = ctx.getTopicBySessionKey(sk)!;
    expect(t.archived).toBe(false);
    const { wakeVerdict } = await import("../../server/lib/wake-adoption");
    expect(wakeVerdict({ id: t.id, archived: t.archived }, () => false)).toBe("adopt");
  }, 20_000);

  // Review 2, B: a CLI grandchild stays `running` 15 minutes after its result;
  // counting rows kept the child running for good, and a restart reported a
  // turn that never happened as `lost`.
  test("a child whose CLI grandchild reported is closed after its wake turn, and a restart reports nothing", async () => {
    mode = "hold";
    const c = await spawn(ROOT2, { name: "c-child" });
    const cid = c.body.agentId as string; const childKey = c.body.sessionKey as string;
    await until("child open", () => open.has(childKey));
    const g = await spawn(childKey, { name: "c-grand-cli", runtime: "claude-code" });
    expect(g.body.runtime).toBe("claude-code");
    const gid = g.body.agentId as string;
    open.get(childKey)!();
    await until("child turn 1", () => reportsFor(cid)[0]);
    expect(rowOf(cid)?.state).toBe("running");
    // The CLI grandchild's turn 1, as the transcript watch reports it: it stays
    // `running`, parked, its phase `finished`.
    const rt = await import("../../server/lib/subagent-runtime");
    rt.reportNativeChildTurn({ id: gid, name: "c-grand-cli", cwd: PROJECT, parentSessionKey: childKey }, 1, { status: "completed", partial: false, text: "grand done" }, null);
    expect(rowOf(gid)?.state).toBe("running");
    await wakeTurn(childKey, "the CLI grandchild's result");
    const second = await until("child turn 2", () => reportsFor(cid)[1]);
    expect(second).toMatchObject({ turn: 2, outcome: { status: "completed", text: "done: the CLI grandchild's result" } });
    await until("the child closed", () => rowOf(cid)?.state === "retired");
    expect(rt.subagentWakeState(ROOT2)).toBe("none");
    const { resetTurnEndRegistry } = await import("../../server/providers/turn-end-registry");
    resetTurnEndRegistry();
    const native = await import("../../server/lib/native-subagents");
    await native.adoptNativeChildrenAtBoot({ waitMs: 300, pollMs: 50 });
    expect(reportsFor(cid).map((r) => [r.turn, r.outcome.status])).toEqual([[1, "completed"], [2, "completed"]]);
  }, 20_000);

  test("a grandchild lost without a result: the waiting child is looked at again and closed, not left running", async () => {
    mode = "hold";
    const c = await spawn(ROOT2, { name: "lost-child" });
    const cid = c.body.agentId as string; const childKey = c.body.sessionKey as string;
    await until("child open", () => open.has(childKey));
    const g = await spawn(childKey, { name: "lost-grand" });
    await until("grand open", () => open.has(g.body.sessionKey as string));
    open.get(childKey)!();
    await until("child turn 1", () => reportsFor(cid)[0]);
    expect(rowOf(cid)?.state).toBe("running");
    // Gone with no result reaching the child: no wake will ever come.
    ctx.db.run("UPDATE subagents SET state = 'lost' WHERE id = ?", [g.body.agentId as string]);
    await until("the child closed", () => rowOf(cid)?.state === "retired", 3_000);
    expect(reportsFor(cid)).toHaveLength(1);
    const rt = await import("../../server/lib/subagent-runtime");
    expect(rt.subagentWakeState(ROOT2)).toBe("none");
  }, 20_000);

  // Review 2, H: a turn's end can read the work as still owed (a command's
  // wake between the stream's end and the SSE close) and the wake then never
  // becomes a turn. Whatever was read at the end, the child is looked at again.
  test("work that was owed at the turn's end and ends without a wake turn: the child is closed", async () => {
    mode = "hold";
    const c = await spawn(ROOT2, { name: "bg-child" });
    const cid = c.body.agentId as string; const childKey = c.body.sessionKey as string;
    await until("child open", () => open.has(childKey));
    busyBackground.add(childKey);
    open.get(childKey)!();
    await until("child turn 1", () => reportsFor(cid)[0]);
    await sleep(300);
    expect(rowOf(cid)?.state).toBe("running");
    busyBackground.delete(childKey);
    await until("the child closed", () => rowOf(cid)?.state === "retired", 3_000);
    expect(reportsFor(cid)).toHaveLength(1);
  }, 20_000);

  // Review 2, E: the listener of the first wake slept through the second and
  // sent one result, with the second's text, for both turns.
  test("two wake turns back to back: each reported once, with its own words", async () => {
    mode = "hold";
    const c = await spawn(ROOT2, { name: "f-child" });
    const cid = c.body.agentId as string; const childKey = c.body.sessionKey as string;
    await until("child open", () => open.has(childKey));
    const g1 = await spawn(childKey, { name: "f-g1" }); const g2 = await spawn(childKey, { name: "f-g2" });
    await until("grands open", () => open.has(g1.body.sessionKey as string) && open.has(g2.body.sessionKey as string));
    open.get(childKey)!();
    await until("child turn 1", () => reportsFor(cid)[0]);
    open.get(g1.body.sessionKey as string)!(); open.get(g2.body.sessionKey as string)!();
    await until("grands reported", () => reportsFor(g1.body.agentId as string)[0] && reportsFor(g2.body.agentId as string)[0]);
    const startHeld = async (text: string) => {
      const url = new URL("http://localhost/api/chat");
      const r = await fakeChatRoute(new Request(url, { method: "POST", body: JSON.stringify({ sessionKey: childKey, messages: [{ content: text }] }) }), url, "/api/chat");
      void (async () => { const rd = r!.body!.getReader(); while (!(await rd.read()).done) { /* drain */ } })();
    };
    await startHeld("wake 1: g1 result");
    await until("w1 open", () => open.has(childKey));
    open.get(childKey)!();
    await sleep(10);
    await startHeld("wake 2: g2 result");
    await sleep(600);
    open.get(childKey)!();
    await until("both wakes reported", () => reportsFor(cid)[2]);
    await sleep(500);
    expect(reportsFor(cid).map((r) => [r.turn, r.outcome.status, r.outcome.text])).toEqual([
      [1, "completed", "done: do the thing"],
      [2, "completed", "done: wake 1: g1 result"],
      [3, "completed", "done: wake 2: g2 result"],
    ]);
  }, 30_000);

  // Review 2, D: two `send_to_agent` racing on a CLI child being migrated both
  // passed the check and migrated it twice; the second turn hit a 409.
  test("two send_to_agent racing on a child being migrated: one resumes it, the other is told it is already resuming", async () => {
    const { body } = await spawn(PARENT, { runtime: "claude-code", name: "race" });
    const id = body.agentId as string;
    ctx.db.run("UPDATE subagents SET runtime_reason = NULL WHERE id = ?", [id]);
    await call(`${agents(PARENT)}/${id}/stop`, "POST");
    ctx.db.run("UPDATE subagents SET state = 'stopped', claude_session_id = ? WHERE id = ?", ["00000000-0000-4000-8000-0000000000ff", id]);
    await sleep(3000);
    const before = reportsFor(id).length;
    mode = "hold";
    const r409 = route409;
    const [a, b] = await Promise.all([
      call(`${agents(PARENT)}/${id}/send`, "POST", { input: "first" }),
      call(`${agents(PARENT)}/${id}/send`, "POST", { input: "second" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const sk = rowOf(id)!.session_key!;
    await until("one turn open", () => open.has(sk));
    open.get(sk)!();
    await until("its result", () => reportsFor(id)[before]);
    await sleep(800);
    expect(route409 - r409).toBe(0);
    expect(reportsFor(id).slice(before).map((r) => r.outcome.status)).toEqual(["completed"]);
  }, 30_000);
});

describe("a Stop reaches the whole live tree (SUBAGENT-11)", () => {
  // Review 2, C: the person's Stop on the root skipped a child waiting on its
  // grandchild, and the grandchild's result then woke the root through it.
  test("a person's Stop on the root stops a waiting child and its grandchild; nothing after it wakes the root", async () => {
    mode = "hold";
    const c = await spawn(ROOT2, { name: "b-child" });
    const cid = c.body.agentId as string; const childKey = c.body.sessionKey as string;
    await until("child open", () => open.has(childKey));
    const g = await spawn(childKey, { name: "b-grand" });
    const gid = g.body.agentId as string; const grandKey = g.body.sessionKey as string;
    await until("grand open", () => open.has(grandKey));
    open.get(childKey)!();
    await until("child turn 1", () => reportsFor(cid)[0]);
    expect(rowOf(cid)?.state).toBe("running");
    const { stopNativeChildrenOf } = await import("../../server/lib/native-subagents");
    expect(await stopNativeChildrenOf(ROOT2)).toBe(1);
    expect(rowOf(cid)?.state).toBe("stopped");
    expect(rowOf(gid)?.state).toBe("stopped");
    expect(open.has(grandKey)).toBe(false);
    const grand = await until("grand's stopped result", () => reportsFor(gid)[0]);
    expect(grand.stoppedByParent).toBe(true);
    // Even a turn on the stopped child's chat reaches nobody.
    await wakeTurn(childKey, "late");
    await sleep(800);
    expect(reportsFor(cid)).toHaveLength(1);
  }, 20_000);

  // Review 2, G: stop_agent on a waiting child stops the same tree, CLI included.
  test("stop_agent on a waiting child stops its native and CLI grandchildren", async () => {
    mode = "hold";
    const c = await spawn(PARENT, { name: "g-child" });
    const cid = c.body.agentId as string; const childKey = c.body.sessionKey as string;
    await until("child open", () => open.has(childKey));
    const gn = await spawn(childKey, { name: "g-native" });
    const gc = await spawn(childKey, { name: "g-cli", runtime: "claude-code" });
    expect(gc.body.runtime).toBe("claude-code");
    await until("native grand open", () => open.has(gn.body.sessionKey as string));
    open.get(childKey)!();
    await until("child turn 1", () => reportsFor(cid)[0]);
    const res = await call(`${agents(PARENT)}/${cid}/stop`, "POST");
    expect(res.status).toBe(200);
    expect(rowOf(cid)?.state).toBe("stopped");
    expect(rowOf(gn.body.agentId as string)?.state).toBe("stopped");
    expect(rowOf(gc.body.agentId as string)?.state).toBe("stopped");
    // Its PTY is killed, not only its row closed.
    await until("the CLI grandchild's kill frame", () => bridge.received.some((m) => m.type === "kill" && (m as { id?: string }).id === gc.body.agentId), 3_000);
  }, 20_000);
});
