/**
 * A command run from the chat, server side: the route that starts it, the row
 * that keeps its outcome, and the doors it must keep shut.
 *
 * The real registry (`routes/processes.ts`) on a test data folder: the command
 * really runs, in the folder the agent of the session works in. What is pinned
 * hardest is what makes this a person's gesture and not the agent's: only a
 * finished reply of the agent of that session, nobody woken, nothing the agent
 * can list or read, nothing a guest can reach.
 *
 * @covers CMDRUN-05, CMDRUN-06
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync } from "fs";
import { join } from "path";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "../../tests/integration/helpers";
import type { AppContext, Topic } from "../types";

const ROOT = testTmpDir("command-runs");
// Before the registry is imported: its boot reads the state folder named then.
setupTestDataDir(join(ROOT, "data"));
const PROJECT = realpathSync((mkdirSync(join(ROOT, "project"), { recursive: true }), join(ROOT, "project")));
const previousQuotaDir = process.env.TOPICS_JOB_QUOTA_DIR;
process.env.TOPICS_JOB_QUOTA_DIR = join(ROOT, "job-quota");

const { commandWakeState, createProcessesRouter, sessionsAwaitingCommandWake } = await import("./processes");
const { isGuestAllowedPath, isGuestSafeFrameType } = await import("../lib/grants");
const { RUN_OUTPUT_MAX_BYTES } = await import("../lib/command-runs");

let ctx: AppContext;
let processes: ReturnType<typeof createProcessesRouter>;
const frames: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  ctx = await createTestAppContext();
  (ctx as { broadcastToAll: unknown }).broadcastToAll = (msg: Record<string, unknown>) => { frames.push(msg); };
  (ctx as { broadcastToTopicSubscribers: unknown }).broadcastToTopicSubscribers = () => {};
  processes = createProcessesRouter(ctx);
});
afterAll(async () => {
  if (previousQuotaDir === undefined) delete process.env.TOPICS_JOB_QUOTA_DIR;
  else process.env.TOPICS_JOB_QUOTA_DIR = previousQuotaDir;
  await cleanupTestDataDir(ROOT);
});

let seq = 0;
function newTopic(over: Partial<Topic> = {}): Topic {
  const name = `run-${++seq}`;
  const topic = {
    id: `t-${name}`, name, slug: name, parentId: null, links: [],
    sessionKey: `topic:${name}`, color: "#5865f2", icon: "MessageSquare",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    archived: false, provider: "claude-code", projectPath: PROJECT, ...over,
  } as Topic;
  ctx.saveSingleTopic(topic);
  return topic;
}
/** A reply of the agent with a bash block, finished unless asked otherwise. */
function reply(topic: Topic, opts: { partial?: boolean; role?: "user" | "assistant" } = {}): string {
  const msg = ctx.appendLocalMessage(topic.sessionKey, opts.role ?? "assistant", "```bash\necho hi\n```");
  if (opts.partial) ctx.db.prepare("UPDATE messages SET partial = 1 WHERE id = ?").run(msg.id);
  return msg.id;
}

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const url = new URL(`http://topics.test${path}`);
  const req = new Request(url, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return (await processes(req, url, url.pathname, method)) as Response;
}
const runsPath = (topic: Topic) => `/api/sessions/${encodeURIComponent(topic.sessionKey)}/command-runs`;
type Started = { runId: string; processId: string; cwd: string; startedAt: string };
async function start(topic: Topic, messageId: string, command: string, blockKey = 0): Promise<Started> {
  const res = await call("POST", runsPath(topic), { messageId, blockKey, command });
  expect(res.status).toBe(200);
  return await res.json() as Started;
}
type Run = { runId: string; blockKey: number; command: string; cwd: string; status: string; exitCode: number | null; startedAt: string; endedAt: string | null; output: string | null; droppedLines: number };
async function runs(topic: Topic, messageId: string): Promise<Run[]> {
  const res = await call("GET", `${runsPath(topic)}?messageId=${encodeURIComponent(messageId)}`);
  expect(res.status).toBe(200);
  return (await res.json() as { runs: Run[] }).runs;
}
async function until(ok: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await ok()) && Date.now() < end) await Bun.sleep(50);
}
async function ended(topic: Topic, messageId: string, runId: string): Promise<Run> {
  let run: Run | undefined;
  await until(async () => (run = (await runs(topic, messageId)).find((r) => r.runId === runId))?.status !== "running");
  return run!;
}
const scriptIds = async () => ((await (await call("GET", "/api/scripts")).json()) as { scripts: Array<{ processId: string }> }).scripts.map((s) => s.processId);
const processCount = () => scriptIds().then((ids) => ids.length);
const rowCount = (sessionKey: string) => (ctx.db.query("SELECT COUNT(*) AS n FROM messages WHERE session_key = ?").get(sessionKey) as { n: number }).n;

describe("POST /api/sessions/:sessionKey/command-runs: what may run", () => {
  test("a finished reply of the session's agent: the command runs in the project, and the answer says where", async () => {
    const topic = newTopic();
    const messageId = reply(topic);
    const run = await start(topic, messageId, "pwd");
    expect(run.runId).toBe(run.processId);
    expect(run.cwd).toBe(PROJECT);
    const done = await ended(topic, messageId, run.runId);
    expect(done).toMatchObject({ status: "done", exitCode: 0, cwd: PROJECT, command: "pwd", blockKey: 0 });
    expect(done.output).toBe(PROJECT);
  });

  test("a chat with no project runs in the agent's own folder, not refused", async () => {
    const topic = newTopic({ projectPath: undefined });
    const messageId = reply(topic);
    const run = await start(topic, messageId, "pwd");
    const home = process.env.CLAUDE_CODE_WORKSPACE || process.env.HOME;
    expect(run.cwd).toBe(home!);
    expect((await ended(topic, messageId, run.runId)).output).toBe(realpathSync(home!));
  });

  test("a reply still being written: 409, and nothing starts", async () => {
    const topic = newTopic();
    const messageId = reply(topic, { partial: true });
    const before = await processCount();
    const res = await call("POST", runsPath(topic), { messageId, blockKey: 0, command: "echo nope" });
    expect(res.status).toBe(409);
    expect(await processCount()).toBe(before);
    expect(await runs(topic, messageId)).toEqual([]);
  });

  test("a person's own message: 404, and nothing starts", async () => {
    const topic = newTopic();
    const messageId = reply(topic, { role: "user" });
    const before = await processCount();
    expect((await call("POST", runsPath(topic), { messageId, blockKey: 0, command: "echo nope" })).status).toBe(404);
    expect(await processCount()).toBe(before);
  });

  test("a reply of another session: 404, and nothing starts", async () => {
    const mine = newTopic();
    const other = newTopic();
    const messageId = reply(other);
    const before = await processCount();
    expect((await call("POST", runsPath(mine), { messageId, blockKey: 0, command: "echo nope" })).status).toBe(404);
    expect((await call("POST", runsPath(mine), { messageId: "no-such-message", blockKey: 0, command: "echo nope" })).status).toBe(404);
    expect(await processCount()).toBe(before);
  });

  test("an empty command or a block key that is not a position: 400", async () => {
    const topic = newTopic();
    const messageId = reply(topic);
    expect((await call("POST", runsPath(topic), { messageId, blockKey: 0, command: "  \n" })).status).toBe(400);
    expect((await call("POST", runsPath(topic), { messageId, blockKey: -1, command: "ls" })).status).toBe(400);
    expect((await call("POST", runsPath(topic), { messageId, blockKey: "0", command: "ls" })).status).toBe(400);
  });

  test("no POSIX shell (Windows): 501, and nothing starts", async () => {
    const topic = newTopic();
    const messageId = reply(topic);
    const before = await processCount();
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    let status: number;
    try {
      status = (await call("POST", runsPath(topic), { messageId, blockKey: 0, command: "ls" })).status;
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
    expect(status).toBe(501);
    expect(await processCount()).toBe(before);
    expect(await runs(topic, messageId)).toEqual([]);
  });
});

describe("a run is the person's, not the agent's", () => {
  test("nobody is woken: the session owes no wake while it runs nor after, and no row is written in the chat", async () => {
    const topic = newTopic();
    const messageId = reply(topic);
    const rowsBefore = rowCount(topic.sessionKey);
    const run = await start(topic, messageId, "sleep 1; exit 3");
    expect(commandWakeState(topic.sessionKey)).toBe("none");
    expect(sessionsAwaitingCommandWake()).not.toContain(topic.sessionKey);
    expect((await ended(topic, messageId, run.runId)).status).toBe("error");
    await Bun.sleep(300);
    expect(commandWakeState(topic.sessionKey)).toBe("none");
    expect(sessionsAwaitingCommandWake()).not.toContain(topic.sessionKey);
    expect(rowCount(topic.sessionKey)).toBe(rowsBefore);
  });

  test("the agent's process tools do not see it: not listed, its output not readable, not stoppable", async () => {
    const topic = newTopic();
    const messageId = reply(topic);
    const run = await start(topic, messageId, "sleep 2; echo secret-output");
    const sk = encodeURIComponent(topic.sessionKey);
    const listed = (await (await call("GET", `/api/sessions/${sk}/scripts`)).json()) as { scripts: Array<{ processId: string }> };
    expect(listed.scripts.map((s) => s.processId)).not.toContain(run.processId);
    expect((await call("GET", `/api/sessions/${sk}/scripts/${run.processId}/output`)).status).toBe(404);
    expect((await call("GET", `/api/sessions/${sk}/scripts/${run.processId}/wait?timeout_ms=100`)).status).toBe(404);
    expect((await call("POST", `/api/sessions/${sk}/scripts/${run.processId}/stop`)).status).toBe(404);
    // The person's Processes panel does see it.
    expect(await scriptIds()).toContain(run.processId);
    expect((await ended(topic, messageId, run.runId)).output).toBe("secret-output");
  });

  test("the colours are on: FORCE_COLOR=1 and no NO_COLOR, unlike run_command", async () => {
    const topic = newTopic();
    const messageId = reply(topic);
    const run = await start(topic, messageId, 'echo "$FORCE_COLOR|$CLICOLOR_FORCE|$NO_COLOR|"');
    expect((await ended(topic, messageId, run.runId)).output).toBe("1|1||");
  });

  test("every change of a run goes out as command-run:updated, a frame no guest receives, on routes no guest reaches", async () => {
    const topic = newTopic();
    const messageId = reply(topic);
    const run = await start(topic, messageId, "true");
    await ended(topic, messageId, run.runId);
    const mine = frames.filter((f) => f.type === "command-run:updated" && f.runId === run.runId);
    expect(mine).toContainEqual({ type: "command-run:updated", sessionKey: topic.sessionKey, messageId, runId: run.runId, status: "running" });
    expect(mine).toContainEqual({ type: "command-run:updated", sessionKey: topic.sessionKey, messageId, runId: run.runId, status: "done" });
    expect(isGuestSafeFrameType("command-run:updated")).toBe(false);
    expect(isGuestAllowedPath(runsPath(topic))).toBe(false);
  });
});

describe("the outcome stays with the block (CMDRUN-06)", () => {
  test("a Stop closes it as stopped, and the process is gone", async () => {
    const topic = newTopic();
    const messageId = reply(topic);
    const run = await start(topic, messageId, "sleep 60");
    expect((await call("POST", `/api/scripts/${run.processId}/stop`)).status).toBe(200);
    const done = await ended(topic, messageId, run.runId);
    expect(done.status).toBe("stopped");
    expect(done.exitCode).toBeNull();
  });

  test("it outlives the registry: twelve commands later the row is gone from the registry and the outcome is still there", async () => {
    const topic = newTopic();
    const messageId = reply(topic);
    const first = await start(topic, messageId, "echo first", 7);
    await ended(topic, messageId, first.runId);
    const other = reply(topic);
    for (let i = 0; i < 12; i++) {
      const r = await start(topic, other, "true", i);
      await ended(topic, other, r.runId);
    }
    expect(await scriptIds()).not.toContain(first.processId);
    const [kept] = await runs(topic, messageId);
    expect(kept).toMatchObject({ runId: first.runId, blockKey: 7, status: "done", exitCode: 0, output: "first", droppedLines: 0 });
    expect(Date.parse(kept!.endedAt!)).toBeGreaterThanOrEqual(Date.parse(kept!.startedAt));
  });

  test("the last run of each block, one per block", async () => {
    const topic = newTopic();
    const messageId = reply(topic);
    const a1 = await start(topic, messageId, "echo a1", 0);
    await ended(topic, messageId, a1.runId);
    const a2 = await start(topic, messageId, "echo a2", 0);
    await ended(topic, messageId, a2.runId);
    const b = await start(topic, messageId, "echo b", 40);
    await ended(topic, messageId, b.runId);
    const list = await runs(topic, messageId);
    expect(list.map((r) => [r.blockKey, r.output]).sort()).toEqual([[0, "a2"], [40, "b"]]);
  });

  test("a huge output is kept as its last 256 KB, from the start of a line, with the lines that did not fit counted", async () => {
    const topic = newTopic();
    const messageId = reply(topic);
    const run = await start(topic, messageId, "seq 1 200000");
    const done = await ended(topic, messageId, run.runId);
    expect(done.status).toBe("done");
    const output = done.output!;
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(RUN_OUTPUT_MAX_BYTES);
    expect(RUN_OUTPUT_MAX_BYTES).toBe(256 * 1024);
    const lines = output.split("\n");
    expect(lines.at(-1)).toBe("200000");
    expect(lines[0]).toBe(String(200000 - lines.length + 1));
    expect(done.droppedLines).toBeGreaterThan(0);
  }, 30_000);

  test("deleting the reply takes its runs with it", async () => {
    const topic = newTopic();
    const messageId = reply(topic);
    for (const k of [0, 1]) {
      const r = await start(topic, messageId, "true", k);
      await ended(topic, messageId, r.runId);
    }
    expect(await runs(topic, messageId)).toHaveLength(2);
    ctx.db.prepare("DELETE FROM messages WHERE id = ?").run(messageId);
    expect((ctx.db.query("SELECT COUNT(*) AS n FROM command_runs WHERE message_id = ?").get(messageId) as { n: number }).n).toBe(0);
  });
});

describe("across a reload of the server", () => {
  const LIFE = join(import.meta.dir, "..", "..", "tests", "integration", "helpers", "command-run-life.ts");
  let lives = 0;
  /** One life of the server on its own state folder; its last line is JSON. Both names of the folder are pinned. */
  function life(dir: string, ...args: string[]): Record<string, any> {
    const out = Bun.spawnSync(["bun", LIFE, ...args], { env: { ...process.env, DATA_DIR: dir, TOPICS_DATA_DIR: dir }, stderr: "pipe" });
    const lines = out.stdout.toString().trim().split("\n");
    return lines.at(-1) ? JSON.parse(lines.at(-1)!) : {};
  }
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const freshState = () => { const dir = join(ROOT, `life-${++lives}`); mkdirSync(dir, { recursive: true }); return dir; };

  test("the server goes away mid-run: the next boot re-adopts it and closes the row when it ends", () => {
    const dir = freshState();
    const started = life(dir, "start", "m-mid", "sleep 2; echo fine");
    expect(alive(started.pid)).toBe(true);
    const { run } = life(dir, "boot", "m-mid", started.runId);
    expect(run).toMatchObject({ runId: started.runId, status: "done", exitCode: 0, output: "fine" });
  }, 40_000);

  test("it ended while the server was down: the boot closes the row from the exit file", async () => {
    const dir = freshState();
    const started = life(dir, "start", "m-down", "echo fine; exit 5");
    await until(() => !alive(started.pid));
    const { run } = life(dir, "boot", "m-down", started.runId);
    expect(run).toMatchObject({ runId: started.runId, status: "error", exitCode: 5, output: "fine" });
  }, 40_000);
});

describe("a guest", () => {
  test("cannot run nor read, even past the gate: 403 guest_forbidden, and nothing starts", async () => {
    const topic = newTopic();
    const messageId = reply(topic);
    const before = await processCount();
    const was = (ctx as { requestIdentity?: unknown }).requestIdentity;
    (ctx as { requestIdentity?: unknown }).requestIdentity = () => ({ role: "guest", deviceId: null });
    try {
      for (const [method, path, body] of [["POST", runsPath(topic), { messageId, blockKey: 0, command: "ls" }], ["GET", `${runsPath(topic)}?messageId=${messageId}`, undefined]] as const) {
        const res = await call(method, path, body);
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({ error: "guest_forbidden" });
      }
    } finally {
      (ctx as { requestIdentity?: unknown }).requestIdentity = was;
    }
    expect(await processCount()).toBe(before);
  });
});
