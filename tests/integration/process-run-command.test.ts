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
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { join } from "path";
import { createTestAppContext, setupTestDataDir, testTmpDir } from "./helpers";
import type { AIProvider, StreamHandler } from "../../server/providers/types";
import type { AppContext, ContentBlock, Topic } from "../../server/types";

const ROOT = testTmpDir("process-run-command");
// Before the registry is imported: it fixes its state folder at import.
setupTestDataDir(join(ROOT, "data"));
const PROJECT = realpathSync((mkdirSync(join(ROOT, "project"), { recursive: true }), join(ROOT, "project")));

const { createProcessesRouter } = await import("../../server/routes/processes");
const { startProcessExitWakes, processExitWakesIdle } = await import("../../server/lib/process-exit-wake");
const { createChatRouter } = await import("../../server/routes/chat");
const { registerProvider, removeProvider } = await import("../../server/providers");

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
    resolveProvider: () => provider,
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
  } as never);
  const processes = createProcessesRouter(ctx);
  startProcessExitWakes({
    db: ctx.db, getTopicById: ctx.getTopicById, isBusy: (sk) => ctx.activeStreams.has(sk), route: chat, pollMs: 50,
  });
  return { ctx: ctx as AppContext, chat, processes, handlers };
}
beforeAll(async () => { bench = await makeBench(); });

let seq = 0;
function newTopic(): Topic {
  const name = `cmd-${++seq}`;
  const topic = {
    id: `t-${name}`, name, slug: name, parentId: null, links: [],
    sessionKey: `topic:${name}`, color: "#5865f2", icon: "MessageSquare",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    archived: false, provider: "openai", projectPath: PROJECT,
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
    const aborter = new AbortController();
    const url = new URL(`http://topics.test/api/sessions/${encodeURIComponent(topic.sessionKey)}/scripts/${processId}/wait?timeout_ms=10000`);
    const waiting = Promise.resolve(bench.processes(new Request(url, { signal: aborter.signal }), url, url.pathname, "GET"));
    await Bun.sleep(200);
    aborter.abort();

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

  test("a Stop from the panel wakes nobody", async () => {
    const topic = newTopic();
    const { processId } = await runCommand(topic, "sleep 30");
    expect((await call(bench.processes, "POST", `/api/scripts/${processId}/stop`)).status).toBe(200);
    await until(async () => (await scriptRow(processId))?.status !== "running");
    await processExitWakesIdle();
    expect(exitRows(topic.sessionKey)).toHaveLength(0);
  });
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
