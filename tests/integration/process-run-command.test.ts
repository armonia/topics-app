/**
 * `run_command` end to end on the server side: the command becomes a row with
 * its output, its end reaches the topic that launched it as ONE row that
 * opens a turn (through the REAL chat route, with a fake provider), and both
 * survive a reload of the server.
 *
 * The reload is two processes on one state folder
 * (`helpers/process-registry-life.ts`): the registry is module state and its
 * boot is its import, so that is what a restart is.
 *
 * @covers CMDRUN-03, CMDRUN-04
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { createTestAppContext, setupTestDataDir, testTmpDir } from "./helpers";
import type { AIProvider, StreamHandler } from "../../server/providers/types";
import type { AppContext, ContentBlock, Topic } from "../../server/types";
import type { TurnEndInfo } from "../../server/services/goal-continuation";
import type { TurnEndInfo as TurnEnd } from "../../server/providers/stop-reason";

const ROOT = testTmpDir("process-run-command");
// Before the registry is imported: it fixes its state folder at import.
setupTestDataDir(join(ROOT, "data"));
const PROJECT = realpathSync((mkdirSync(join(ROOT, "project"), { recursive: true }), join(ROOT, "project")));

const { commandWakeState, createProcessesRouter, logPathOf } = await import("../../server/routes/processes");
const { startProcessExitWakes, processExitWakesIdle } = await import("../../server/lib/process-exit-wake");
const { runningTaskOwnsTopic } = await import("../../server/lib/wake-adoption");
const { createChatRouter } = await import("../../server/routes/chat");
const { registerProvider, removeProvider } = await import("../../server/providers");
const { TopicsRoutingIncompatibleError } = await import("../../server/providers/resolve-topic-provider");

registerProvider({ type: "openai", apiKey: "" } as never);
afterAll(async () => {
  try { removeProvider("openai"); } catch { /* already gone */ }
  const { closeDatabase } = await import("../../server/db");
  closeDatabase();
});

type Row = { processId: string; status: string; exitCode?: number; source?: string; topicId?: string };

/** The bench: a topic bound to a project, the real chat route, the real registry. */
let bench: Awaited<ReturnType<typeof makeBench>>;
async function makeBench() {
  const ctx = await createTestAppContext();
  (ctx as { broadcastToTopicSubscribers: unknown }).broadcastToTopicSubscribers = () => {};
  (ctx as { resolveTopicCwd: unknown }).resolveTopicCwd = () => PROJECT;
  const handlers: StreamHandler[] = [];
  // What the goal loop hears at every turn end, in place of the loop itself.
  const goalTurns: TurnEndInfo[] = [];
  const goalLoop = {
    useRoute() {}, stopWaiting() {}, resumeAfterBoot: async () => {},
    onTurnEnd: async (i: TurnEndInfo) => { goalTurns.push(i); return "seen"; },
  };
  const provider = {
    name: "fake-stream",
    capabilities: new Set(["streaming"]),
    contextStrategy: "history-aware",
    get connected() { return true; },
    registerStreamHandler: (_sk: string, _rid: string | undefined, h: StreamHandler) => { handlers.push(h); },
    unregisterStreamHandler: () => {},
    sendChat: () => new Promise<{ runId?: string }>(() => {}),
    defaultModel: () => "fake-model",
    abort: async () => {},
    start: () => {}, stop: () => {},
    complete: async () => ({ content: "" }),
  } as unknown as AIProvider;
  const chat = createChatRouter(ctx, {
    // A topic with the light routing switch on stands for one whose pinned
    // provider the native engine cannot run: the real resolver throws this.
    resolveProvider: (topic: Topic | null) => {
      if (topic?.topicsRouting) throw new TopicsRoutingIncompatibleError("openai", "not routable");
      return provider;
    },
    detectLocalhostAutoNav: () => {},
    bindTopicToProject: () => {},
    resolveProjectRef: () => null,
    getProjectIdForTopic: () => null,
    getWorkspaceProjects: () => [],
    autoBindProject: () => {},
    watchSessionForSubagents: () => {},
    updateUnreadCount: () => {},
    browserNavigatedTopics: new Set<string>(),
    WORKSPACE_DIR: join(ROOT, "ws"),
    goalLoop,
  } as never);
  const processes = createProcessesRouter(ctx);
  startProcessExitWakes({
    db: ctx.db, getTopicById: ctx.getTopicById, ownedByRunningTask: (id) => runningTaskOwnsTopic(ctx.db, id),
    isBusy: (sk) => ctx.activeStreams.has(sk), route: chat, pollMs: 50,
  });
  return { ctx: ctx as AppContext, chat, processes, handlers, goalTurns };
}
beforeAll(async () => { bench = await makeBench(); });

let seq = 0;
function newTopic(over: Partial<Topic> = {}): Topic {
  const name = `cmd-${++seq}`;
  const topic = {
    id: `t-${name}`, name, slug: name, parentId: null, links: [],
    sessionKey: `topic:${name}`, color: "#5865f2", icon: "MessageSquare",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    archived: false, provider: "openai", projectPath: PROJECT, ...over,
  } as Topic;
  bench.ctx.saveSingleTopic(topic);
  return topic;
}

async function call(router: (req: Request, url: URL, p: string, m: string) => unknown, method: string, path: string, body?: unknown): Promise<Response> {
  const url = new URL(`http://topics.test${path}`);
  const req = new Request(url, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return (await router(req, url, url.pathname, method)) as Response;
}
const runCommand = async (topic: Topic, command: string) =>
  (await (await call(bench.processes, "POST", `/api/sessions/${encodeURIComponent(topic.sessionKey)}/commands/run`, { command })).json()) as { processId: string; pid: number };

const rows = (sessionKey: string) => bench.ctx.db
  .query(`SELECT role, content, blocks FROM messages WHERE session_key = ? ORDER BY sort_order ASC, rowid ASC`)
  .all(sessionKey) as Array<{ role: string; content: string; blocks: string | null }>;
const exitRows = (sessionKey: string) => rows(sessionKey).filter((r) => (JSON.parse(r.blocks ?? "null") as ContentBlock[] | null)?.some((b) => b.kind === "process-exit"));

async function until(ok: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await ok()) && Date.now() < end) await Bun.sleep(50);
}
async function scriptRow(processId: string): Promise<Row | undefined> {
  const { scripts } = await (await call(bench.processes, "GET", "/api/scripts")).json() as { scripts: Row[] };
  return scripts.find((s) => s.processId === processId);
}
/** Ends the turn in flight the way the model would. */
async function finishTurn(text = "ok") {
  const h = bench.handlers[bench.handlers.length - 1]!;
  h.onTextDelta(text, text);
  h.onDone();
  await Bun.sleep(100);
}

describe("the end of a command reaches the topic that launched it", () => {
  test("one row marked process-exit with the code and the last lines, and a turn on it", async () => {
    const topic = newTopic();
    const turnsBefore = bench.handlers.length;
    const { processId } = await runCommand(topic, "echo tick 1; echo tick 2; exit 3");

    await until(async () => (await scriptRow(processId))?.status !== "running");
    const row = await scriptRow(processId);
    expect(row).toMatchObject({ source: "command", topicId: topic.id, status: "error", exitCode: 3 });
    const log = await (await call(bench.processes, "GET", `/api/scripts/${processId}/output`)).json() as { output: string };
    expect(log.output).toContain("tick 1");
    expect(log.output).toContain("tick 2");

    await until(() => exitRows(topic.sessionKey).length > 0);
    const wakes = exitRows(topic.sessionKey);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.role).toBe("user");
    expect(wakes[0]!.content).toContain("exit 3");
    expect(wakes[0]!.content).toContain("tick 2");
    expect(JSON.parse(wakes[0]!.blocks!)).toEqual([{ kind: "process-exit", processId, exitCode: 3, label: "echo tick 1; echo tick 2; exit 3" }]);
    // A turn of the agent started on that row.
    expect(bench.handlers.length).toBe(turnsBefore + 1);
    await finishTurn();
    await processExitWakesIdle();
    expect(exitRows(topic.sessionKey)).toHaveLength(1);
  });

  test("a turn in flight is not cut: the wake arrives after it, and no request is lost to a 409", async () => {
    const topic = newTopic();
    const send = await call(bench.chat, "POST", "/api/chat", { sessionKey: topic.sessionKey, messages: [{ role: "user", content: "keep working" }] });
    expect(send.status).toBe(200);
    void send.body?.cancel().catch(() => {});

    const { processId } = await runCommand(topic, "echo quick; exit 0");
    await until(async () => (await scriptRow(processId))?.status !== "running");
    await Bun.sleep(600);
    expect(exitRows(topic.sessionKey)).toHaveLength(0);

    await finishTurn("done with that");
    await until(() => exitRows(topic.sessionKey).length > 0);
    const all = rows(topic.sessionKey);
    const at = all.findIndex((r) => r.blocks?.includes("process-exit"));
    expect(all.slice(0, at).map((r) => r.role)).toEqual(["user", "assistant"]);
    expect(all[at]!.content).toContain("exit 0");
    await finishTurn();
    await processExitWakesIdle();
  });

  test("the session waiting on it with wait_for_process gets the outcome there, and no row", async () => {
    const topic = newTopic();
    const { processId } = await runCommand(topic, "sleep 1; echo waited");
    const wait = await call(bench.processes, "GET", `/api/sessions/${encodeURIComponent(topic.sessionKey)}/scripts/${processId}/wait?timeout_ms=10000`);
    expect(await wait.json()).toMatchObject({ reason: "exit", exitCode: 0 });
    await Bun.sleep(600);
    await processExitWakesIdle();
    expect(exitRows(topic.sessionKey)).toHaveLength(0);
  });

  // The caller of a wait can go away without the wait ending: the CLI restarts,
  // the turn is stopped, the MCP bridge dies. Its watch stayed open until the
  // timeout, and a command ending in that window counted as «already waited
  // for»: nobody got the outcome.
  test("a wait whose caller went away does not swallow the wake", async () => {
    const topic = newTopic();
    const { processId } = await runCommand(topic, "sleep 1; echo gone-waiting");
    const controller = new AbortController();
    const url = new URL(`http://topics.test/api/sessions/${encodeURIComponent(topic.sessionKey)}/scripts/${processId}/wait?timeout_ms=10000`);
    const waiting = Promise.resolve(bench.processes(new Request(url, { signal: controller.signal }), url, url.pathname, "GET"));
    await Bun.sleep(200);
    controller.abort();

    await until(() => exitRows(topic.sessionKey).length > 0);
    expect(exitRows(topic.sessionKey)).toHaveLength(1);
    expect(exitRows(topic.sessionKey)[0]!.content).toContain("gone-waiting");
    await waiting;
    await finishTurn();
    await processExitWakesIdle();
  });

  test("an archived topic gets nothing, and the outcome stays in the panel", async () => {
    const topic = newTopic();
    const { processId } = await runCommand(topic, "sleep 0.5; exit 1");
    bench.ctx.saveSingleTopic({ ...topic, archived: true });
    await until(async () => (await scriptRow(processId))?.status !== "running");
    await processExitWakesIdle();
    expect(exitRows(topic.sessionKey)).toHaveLength(0);
    expect(await scriptRow(processId)).toMatchObject({ status: "error", exitCode: 1 });
  });

  // The route refuses with a 409 that no turn clears: the topic's routing
  // cannot reach its provider until somebody changes a setting. Waited on as
  // if the session were busy, the wake posted twice a second forever and the
  // topic's chain never ran another one.
  test("a refusal that is not a busy session ends the wait: no row, and the wake stays owed", async () => {
    const topic = newTopic({ topicsRouting: true });
    const refused = await call(bench.chat, "POST", "/api/chat", { sessionKey: topic.sessionKey, messages: [{ role: "user", content: "hi" }] });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "topics_routing_incompatible" });

    const { processId } = await runCommand(topic, "echo refused; exit 0");
    await until(async () => (await scriptRow(processId))?.status !== "running");
    const outcome = await Promise.race([processExitWakesIdle().then(() => "settled"), Bun.sleep(3000).then(() => "still waiting")]);
    expect(outcome).toBe("settled");
    expect(exitRows(topic.sessionKey)).toHaveLength(0);
    // Beside the logs: the registry's folder is the one of the first file that loaded it.
    const saved = JSON.parse(readFileSync(join(dirname(dirname(logPathOf(processId))), "scripts.json"), "utf8")) as { recent: Array<{ processId: string; cmd?: { wake: boolean } }> };
    expect(saved.recent.find((r) => r.processId === processId)?.cmd?.wake).toBe(true);
    // Owed to the next boot, not to anybody waiting now: counted as queued, it
    // held the topic's goal (and a board card) on a wake that cannot come
    // before a restart.
    expect(commandWakeState(topic.sessionKey)).toBe("none");
  });

  test("a Stop from the panel wakes nobody", async () => {
    const topic = newTopic();
    const { processId } = await runCommand(topic, "sleep 30");
    expect((await call(bench.processes, "POST", `/api/scripts/${processId}/stop`)).status).toBe(200);
    await until(async () => (await scriptRow(processId))?.status !== "running");
    await processExitWakesIdle();
    expect(exitRows(topic.sessionKey)).toHaveLength(0);
  });
});

// A goal waits for the background work a turn leaves behind instead of nudging
// over it (`services/goal-loop.ts`). A `run_command` owed a wake is that work:
// counted as nothing, a goal topic whose agent ended its turn on a long command
// was judged, nudged turn after turn, and paused as stalled before the wake came.
describe("a command owed a wake is background work for the goal loop", () => {
  const lastGoalTurn = (topic: Topic) => bench.goalTurns.filter((t) => t.sessionKey === topic.sessionKey).at(-1);

  test("a turn that ends with the command running waits for it, and the wake's turn is a woken one", async () => {
    const topic = newTopic();
    await runCommand(topic, "sleep 1.5; echo goal-wake");
    const send = await call(bench.chat, "POST", "/api/chat", { sessionKey: topic.sessionKey, messages: [{ role: "user", content: "started it, waiting" }] });
    expect(send.status).toBe(200);
    void send.body?.cancel().catch(() => {});
    await finishTurn("it runs, I will be woken");
    expect(lastGoalTurn(topic)).toMatchObject({ fromHuman: true, backgroundWork: true, backgroundWakeOnly: false });

    await until(() => exitRows(topic.sessionKey).length > 0);
    await finishTurn("read the outcome");
    // Nothing is owed any more: the wake's own turn is judged, and counts as news.
    expect(lastGoalTurn(topic)).toMatchObject({ fromHuman: false, woken: true, backgroundWork: false });
    await processExitWakesIdle();
  });

  test("a command that ended during the turn, its wake still to send, is a wake queued", async () => {
    const topic = newTopic();
    const send = await call(bench.chat, "POST", "/api/chat", { sessionKey: topic.sessionKey, messages: [{ role: "user", content: "keep working" }] });
    void send.body?.cancel().catch(() => {});
    const { processId } = await runCommand(topic, "echo quick-goal; exit 0");
    await until(async () => (await scriptRow(processId))?.status !== "running");
    await finishTurn("done with that");
    expect(lastGoalTurn(topic)).toMatchObject({ backgroundWork: true, backgroundWakeOnly: true });

    await until(() => exitRows(topic.sessionKey).length > 0);
    await finishTurn();
    expect(lastGoalTurn(topic)).toMatchObject({ woken: true, backgroundWork: false });
    await processExitWakesIdle();
  });
});

// A board agent is told to wait for its `run_command` inside the turn
// (`longCommandsRule`), but one can still end the turn on it. The dispatcher
// read that end as an interrupted turn: a nudge over the running command and
// an attempt spent, and with the default cap of 2 the card was parked before
// the command ended (both verifiers of 28/09).
describe("a board card whose agent ended its turn on a command", () => {
  test("is not nudged and spends no attempt; the wake's turn runs, and then the card goes on", async () => {
    const { createTaskService } = await import("../../server/services/tasks");
    const { createTaskDispatcher } = await import("../../server/services/task-dispatcher");
    // The dispatcher's session of a card: `topic:` and the first 8 characters of its topic id.
    // Archived, as the dispatcher creates it (`createDetachedTopic` with `background: true`).
    const topic = newTopic({ id: "cardwake-topic", sessionKey: "topic:cardwake", archived: true });
    const db = bench.ctx.db;
    const svc = createTaskService(db);
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, dispatch_attempts, assigned_topic_id, dispatch_state)
       VALUES ('card-wake', 'board-wake', 'wait on a command', 'in_progress', ?, ?, 1, ?, 'working')`,
      [now, now, topic.id],
    );
    svc.updateBoardSettings("board-wake", { autoDispatch: true, dispatchUseWorktree: false });
    const turns: string[] = [];
    const turn: { end?: (info: TurnEnd) => void } = {};
    const dispatcher = createTaskDispatcher({
      svc,
      resolveProject: () => ({ path: PROJECT, projectStoreId: null }),
      createTopic: () => ({ topicId: topic.id, sessionKey: topic.sessionKey }),
      topicExists: () => true,
      runTurn: (_sk, content) => new Promise<TurnEnd | void>((res) => { turns.push(content); turn.end = res; }),
      awaitsCommandWake: (sk) => commandWakeState(sk) !== "none",
      isSessionBusy: (sk) => bench.ctx.activeStreams.has(sk),
      broadcast: () => {}, graceMs: 0, retryBackoffMs: 0, log: () => {},
    });
    const attempts = () => svc.get("card-wake")!.task.dispatchAttempts;
    const poll = async () => { await dispatcher.reconcile({ reason: "poll" }); await Bun.sleep(20); };
    try {
      // The card's turn, as the boot resumes it; during it the agent starts a command.
      await dispatcher.reconcile({ reason: "boot" });
      expect(turns).toHaveLength(1);
      const { processId } = await runCommand(topic, "sleep 1.5; echo card-wake");
      turn.end?.({ end: "end_turn" });
      await Bun.sleep(50);
      expect(turns).toHaveLength(1);
      expect(attempts()).toBe(1);
      await poll();
      expect(turns).toHaveLength(1);

      // The command ends: its wake opens a turn of the agent on the card's session.
      await until(() => exitRows(topic.sessionKey).length > 0);
      expect(exitRows(topic.sessionKey)[0]!.content).toContain("card-wake");
      expect((await scriptRow(processId))?.status).toBe("done");
      await poll();
      expect(turns).toHaveLength(1);
      // That turn ends without delivering: the card goes on as after any turn.
      await finishTurn("read it");
      await processExitWakesIdle();
      await poll();
      expect(turns).toHaveLength(2);
      expect(attempts()).toBe(2);
      expect(svc.get("card-wake")!.task.status).toBe("in_progress");
    } finally {
      dispatcher.shutdown();
    }
  });

  // The launch path reads the worktree's git stat between the end of the
  // card's turn and `onTurnEnd` (up to 15 s). A command that ended during the
  // turn had its wake accepted in that window, and the wake counted as settled
  // as soon as the route took its row: the card read «nothing owed» while the
  // wake's turn ran, spent an attempt and sent a nudge over it (both verifiers
  // of 28/09 at 4619574c1). Here the stat returns only once the wake's row is
  // in the chat, which is that window without a clock.
  test("a command that ended during the launch turn: its wake's turn holds the card through the git stat", async () => {
    const { createTaskService } = await import("../../server/services/tasks");
    const { createTaskDispatcher } = await import("../../server/services/task-dispatcher");
    const { createTaskAttemptStore } = await import("../../server/services/task-attempts");
    const topic = newTopic({ id: "launchwake-topic", sessionKey: "topic:launchwa", archived: true });
    const db = bench.ctx.db;
    const svc = createTaskService(db);
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, dispatch_attempts)
       VALUES ('card-launch', 'board-launch', 'command during the launch turn', 'todo', ?, ?, 0)`,
      [now, now],
    );
    svc.updateBoardSettings("board-launch", { autoDispatch: true });
    const sent: string[] = [];
    // The real front door, as `runHeadlessTurn` drives it: the card's turn holds `activeStreams`.
    const runTurn = async (sk: string, content: string): Promise<TurnEnd> => {
      sent.push(content);
      const r = await call(bench.chat, "POST", "/api/chat", { sessionKey: sk, messages: [{ role: "user", content }], dispatched: true, contextMode: "full" });
      if (r.status === 409) { await r.body?.cancel().catch(() => {}); return { end: "cancelled", cause: "turn-in-flight" }; }
      const reader = r.body!.getReader();
      while (!(await reader.read()).done) { /* the turn is still running */ }
      return { end: "end_turn" };
    };
    const dispatcher = createTaskDispatcher({
      svc,
      attempts: createTaskAttemptStore(db),
      resolveProject: () => ({ path: PROJECT, projectStoreId: "store-launch" }),
      createTopic: () => ({ topicId: topic.id, sessionKey: topic.sessionKey }),
      createWorktree: async () => "wt-launch",
      attemptStats: async () => { await until(() => exitRows(topic.sessionKey).length > 0); return null; },
      topicExists: () => true,
      runTurn,
      awaitsCommandWake: (sk) => commandWakeState(sk) !== "none",
      isSessionBusy: (sk) => bench.ctx.activeStreams.has(sk),
      broadcast: () => {}, graceMs: 0, retryBackoffMs: 0, log: () => {},
    } as never);
    const card = () => svc.get("card-launch")!.task;
    const waitNoted = () => svc.get("card-launch")!.comments.some((c) => c.author === "system" && c.content.includes("run_command"));
    try {
      await dispatcher.tick("board-launch");
      await until(() => bench.ctx.activeStreams.has(topic.sessionKey));
      expect(sent).toHaveLength(1);
      // During the card's turn the agent starts a short command, which ends before the turn does.
      const { processId } = await runCommand(topic, "echo launch-wake; exit 0");
      await until(async () => (await scriptRow(processId))?.status !== "running");
      await finishTurn("ended my turn");
      // `onTurnEnd` has run once it either waits (its note) or spent an attempt.
      await until(() => waitNoted() || card().dispatchAttempts !== 1);
      // The wake's turn runs: the card waits for it, no nudge and no attempt.
      expect(bench.ctx.activeStreams.has(topic.sessionKey)).toBe(true);
      expect(commandWakeState(topic.sessionKey)).toBe("wake-queued");
      expect(card().dispatchAttempts).toBe(1);
      expect(sent).toHaveLength(1);
      expect(waitNoted()).toBe(true);

      // Once the wake's turn is over nothing is owed, and the card goes on as after any turn.
      await finishTurn("read it");
      await processExitWakesIdle();
      expect(commandWakeState(topic.sessionKey)).toBe("none");
      await dispatcher.reconcile({ reason: "poll" });
      await until(() => sent.length > 1);
      expect(sent).toHaveLength(2);
      expect(card().dispatchAttempts).toBe(2);
    } finally {
      dispatcher.shutdown();
      if (bench.ctx.activeStreams.has(topic.sessionKey)) await finishTurn("closing");
      await processExitWakesIdle();
    }
  });
});

// The command writes its log itself, so the registry's rotation of a script's
// log never touched it: a dev server left running grew it without bound, and
// the file then stayed on disk seven more days.
describe("a command's log file is bounded like a script's", () => {
  test("cut to its last 500 KB while it runs and when it ends, the last lines kept", async () => {
    const topic = newTopic();
    // About 3 MB at once, then quiet for a few ticks of the tail.
    const line = "x".repeat(99);
    const started = await call(bench.processes, "POST", `/api/sessions/${encodeURIComponent(topic.sessionKey)}/commands/run`, {
      command: `yes ${line} | head -n 30000; sleep 3; echo last line`, wake: false,
    });
    const { processId } = (await started.json()) as { processId: string };
    const log = logPathOf(processId);
    const output = async () => ((await (await call(bench.processes, "GET", `/api/scripts/${processId}/output`)).json()) as { output: string }).output;

    // The tick that brought the burst into the panel has cut the file too.
    await until(async () => (await output()).includes(line));
    expect(statSync(log).size).toBeLessThanOrEqual(500 * 1024);
    expect((await scriptRow(processId))?.status).toBe("running");

    await until(async () => (await scriptRow(processId))?.status !== "running");
    expect(statSync(log).size).toBeLessThanOrEqual(500 * 1024);
    expect(readFileSync(log, "utf8").endsWith(`${line}\nlast line\n`)).toBe(true);
    expect(await output()).toContain("last line");
  }, 20_000);
});

// ── Across a reload of the server ────────────────────────────────────────────

const LIFE = join(import.meta.dir, "helpers", "process-registry-life.ts");

describe("the command outlives the server", () => {
  let state = "";
  let dbPath = "";
  beforeAll(() => {
    state = join(ROOT, `life-${Date.now()}`);
    mkdirSync(state, { recursive: true });
    dbPath = join(state, "wakes.db");
    const db = new Database(dbPath);
    db.run("CREATE TABLE messages (session_key TEXT, role TEXT, content TEXT, blocks TEXT)");
    db.close();
  });

  /** One life of the registry on a state folder; its last line, when any, is JSON. */
  function lifeIn(dir: string, ...args: string[]): Record<string, any> {
    const out = Bun.spawnSync(["bun", LIFE, ...args], { env: { ...process.env, DATA_DIR: dir }, stderr: "pipe" });
    const lines = out.stdout.toString().trim().split("\n");
    return lines[lines.length - 1] ? JSON.parse(lines[lines.length - 1]!) : {};
  }
  const life = (...args: string[]) => lifeIn(state, ...args);
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  test("a reload mid-run: the row comes back running, the log goes on, the code is read from the exit file, one wake", () => {
    const started = life("start", PROJECT, "echo tick 1; sleep 3; echo tick 2; exit 3");
    // The server that launched it is gone; the command is not.
    expect(alive(started.pid)).toBe(true);

    const first = life("boot", PROJECT, started.processId, dbPath);
    expect(first.row).toMatchObject({ processId: started.processId, status: "error", exitCode: 3 });
    expect(first.log).toContain("tick 1");
    expect(first.log).toContain("tick 2"); // printed after the reload
    expect(first.sent).toBe(1);

    // A second boot does not repeat it.
    expect(life("boot", PROJECT, started.processId, dbPath).sent).toBe(0);
  }, 40_000);

  test("it ended while the server was down: the next boot reads its code and delivers the wake once", async () => {
    const started = life("start", PROJECT, "echo tick 1; echo tick 2; exit 4");
    await until(() => existsSync(join(state, ".state", "scripts", `${started.processId}.exit`)));
    await until(() => !alive(started.pid));

    const first = life("boot", PROJECT, started.processId, dbPath);
    expect(first.row).toMatchObject({ status: "error", exitCode: 4 });
    expect(first.log).toContain("tick 2");
    expect(first.sent).toBe(1);
    expect(life("boot", PROJECT, started.processId, dbPath).sent).toBe(0);
    const db = new Database(dbPath);
    const delivered = db.query("SELECT content FROM messages WHERE blocks LIKE ?").all(`%${started.processId}%`) as Array<{ content: string }>;
    db.close();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.content).toContain("exit 4");
  }, 40_000);

  // CMDRUN-04, «the server dies between the exit and the delivery». The owed
  // wake lives in `scripts.json` only as long as its row is among the recent
  // ones, and every script and every agent's shell ends up there too.
  test("a wake still owed survives ten other endings before the reload", () => {
    const { processId } = life("crowd", PROJECT, "echo owed; exit 5", "10");
    expect(processId).toBeTruthy();
    const booted = life("boot", PROJECT, processId, dbPath);
    expect(booted.row).toMatchObject({ processId, status: "error", exitCode: 5 });
    expect(booted.sent).toBe(1);
  }, 60_000);

  // `finishCommand` saves the registry. Called from inside the boot's loop, it
  // wrote a `scripts.json` without the rows the loop had not reached yet, and
  // the next reload lost them: live processes out of the panel, a command
  // waking nobody.
  test("a command found dead at boot does not drop the live processes listed after it", () => {
    const dir = join(ROOT, `load-${Date.now()}`);
    mkdirSync(join(dir, ".state", "scripts"), { recursive: true });
    const live = Bun.spawn(["sleep", "120"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    try {
      const lstart = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(live.pid)]).stdout.toString().trim();
      const base = { projectPath: PROJECT, status: "running", startedAt: new Date().toISOString() };
      writeFileSync(join(dir, ".state", "scripts.json"), JSON.stringify({
        running: [
          { ...base, processId: "dead-cmd", scriptName: "echo", command: "echo", pid: 999999, pidLstart: "gone",
            source: "command", cmd: { sessionKey: "topic:life", topicId: "topic-life", wake: false } },
          { ...base, processId: "live-script", scriptName: "sleep", command: "sleep 120", pid: live.pid, pidLstart: lstart },
        ],
        recent: [],
      }));
      lifeIn(dir, "load");
      const saved = JSON.parse(readFileSync(join(dir, ".state", "scripts.json"), "utf8")) as { running: Array<{ processId: string }>; recent: Array<{ processId: string }> };
      expect(saved.running.map((r) => r.processId)).toEqual(["live-script"]);
      expect(saved.recent.map((r) => r.processId)).toEqual(["dead-cmd"]);
    } finally {
      live.kill("SIGKILL");
    }
  }, 30_000);

  test("no exit file: the row closes as an error with an unknown code, never as done", async () => {
    const started = life("start", PROJECT, "sleep 30");
    // Killed so hard the wrapper cannot write the code: the whole group, at once.
    process.kill(-started.pid, "SIGKILL");
    await until(() => !alive(started.pid));

    const booted = life("boot", PROJECT, started.processId, dbPath);
    expect(booted.row.status).toBe("error");
    expect(booted.row.exitCode).toBeUndefined();
    const db = new Database(dbPath);
    const delivered = db.query("SELECT content FROM messages WHERE blocks LIKE ?").all(`%${started.processId}%`) as Array<{ content: string }>;
    db.close();
    expect(delivered[0]?.content).toContain("exit code unknown");
  }, 40_000);
});
