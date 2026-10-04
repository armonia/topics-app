/**
 * A `run_command` process is background work of the chat that started it
 * (BGVIS-07): the registry names it to the chat's background line while it
 * runs, turn open or not, says whether its end will wake the chat, pushes
 * `background:changed` when it starts and when it ends, and keeps naming it
 * after a restart only if it is still alive.
 *
 * On 30/09 an agent started a loop with `run_command`, told the person "this
 * topic gets a message when it ends" and ended its turn: the line read only
 * the CLI's own tasks, and the chat showed nothing for as long as it ran.
 *
 * Real spawns, short commands. The restart is a second process on the same
 * state folder (`tests/integration/helpers/process-registry-life.ts`): the
 * registry is module state, loaded once per process.
 *
 * @covers BGVIS-07
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// The registry keeps its state in the folder DATA_DIR names: this file's own.
const STATE = mkdtempSync(join(tmpdir(), "topics-cmd-bg-state-"));
const previousDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = STATE;
const { commandBackgroundWork, createProcessesRouter } = await import("./processes");
const { withBackgroundWork } = await import("../providers/background-probes");

const PROJECT = realpathSync(mkdtempSync(join(tmpdir(), "topics-cmd-bg-project-")));
afterAll(() => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  rmSync(STATE, { recursive: true, force: true });
  rmSync(PROJECT, { recursive: true, force: true });
});

const TOPIC = { id: "topic-bg", sessionKey: "topic:bg" };
const topicOf = (k: string) => (k === TOPIC.sessionKey ? TOPIC : null);
const frames: Array<{ type: string; topicId?: string; sessionKey?: string }> = [];

const router = createProcessesRouter({
  db: { query: () => ({ get: () => null }) },
  json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
  broadcastToAll: (m: { type: string }) => { frames.push(m); },
  getTopicBySessionKey: topicOf,
  resolveTopicCwd: () => PROJECT,
} as never);

async function run(body: Record<string, unknown>): Promise<{ processId: string; wake: boolean }> {
  const url = new URL(`http://x/api/sessions/${encodeURIComponent(TOPIC.sessionKey)}/commands/run`);
  const req = new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const resp = (await router(req, url, url.pathname, "POST"))!;
  expect(resp.status).toBe(200);
  return await resp.json() as { processId: string; wake: boolean };
}

async function stop(processId: string): Promise<void> {
  const url = new URL(`http://x/api/scripts/${processId}/stop`);
  await router(new Request(url, { method: "POST" }), url, url.pathname, "POST");
}

async function until(ok: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await Bun.sleep(50);
}

const pushes = () => frames.filter((f) => f.type === "background:changed");
const tasksOf = () => commandBackgroundWork.tasks(TOPIC.sessionKey);

describe("a run_command process on the chat's background line", () => {
  test("named, timed and waking while it runs, with no turn open and beside an open turn; gone and pushed when it ends", async () => {
    frames.length = 0;
    const before = Date.now();
    const { processId } = await run({ command: "sleep 1; echo BG-LAST 7", description: "  BGJOB  wait for the batch " });

    expect(commandBackgroundWork.sessions()).toEqual([TOPIC.sessionKey]);
    const [task] = tasksOf();
    expect(task).toMatchObject({ type: "command", description: "BGJOB wait for the batch", processId, wakes: true });
    expect(task!.startedAt!).toBeGreaterThanOrEqual(before - 1000);
    expect(task!.startedAt!).toBeLessThanOrEqual(Date.now());
    // The start is pushed, so the line names it now and not at the next poll.
    expect(pushes()).toEqual([{ type: "background:changed", topicId: TOPIC.id, sessionKey: TOPIC.sessionKey }]);

    // No turn open: a background row of its own, with no CLI news to age.
    const idle = withBackgroundWork([], topicOf, commandBackgroundWork);
    expect(idle).toEqual([{ topicId: TOPIC.id, sessionKey: TOPIC.sessionKey, state: "background", tasks: [task!], lastSignalAt: 0 }]);
    // A turn open: one row for the session, the turn's, naming the command beside it.
    const open = withBackgroundWork([{ topicId: TOPIC.id, sessionKey: TOPIC.sessionKey, state: "streaming" }], topicOf, commandBackgroundWork);
    expect(open).toEqual([{ topicId: TOPIC.id, sessionKey: TOPIC.sessionKey, state: "streaming", background: { tasks: [task!], lastSignalAt: 0 } }]);

    // It ends by itself: no longer named, and the end is pushed too.
    await until(() => tasksOf().length === 0);
    expect(tasksOf()).toEqual([]);
    expect(commandBackgroundWork.sessions()).toEqual([]);
    expect(withBackgroundWork([], topicOf, commandBackgroundWork)).toEqual([]);
    expect(pushes()).toHaveLength(2);
  }, 20_000);

  test("a command that owes no wake is still listed, as Claude Code lists a background dev server, and says it does not wake", async () => {
    frames.length = 0;
    const { processId } = await run({ command: "sleep 30", wake: false });
    try {
      expect(tasksOf()).toMatchObject([{ type: "command", description: "sleep 30", processId, wakes: false }]);
    } finally {
      await stop(processId);
    }
    // A Stop from the panel ends it like an exit: gone from the line, pushed.
    await until(() => tasksOf().length === 0);
    expect(tasksOf()).toEqual([]);
    expect(pushes()).toHaveLength(2);
  }, 20_000);

  test("with no description the name is the command's first line, cut", async () => {
    const long = `for i in 1 2 3; do echo tick-$i-${"x".repeat(60)}`;
    const { processId } = await run({ command: `${long}\n  sleep 30\ndone`, wake: false });
    try {
      const [task] = tasksOf();
      expect(task!.description).toBe(`${long.slice(0, 47)}…`);
      expect(task!.description).not.toContain("sleep");
    } finally {
      await stop(processId);
      await until(() => tasksOf().length === 0);
    }
  }, 20_000);
});

describe("after a restart", () => {
  const LIFE = join(import.meta.dir, "..", "..", "tests", "integration", "helpers", "process-registry-life.ts");

  test("a command still alive keeps its place on the line, one that died while the server was down does not", () => {
    const dir = mkdtempSync(join(tmpdir(), "topics-cmd-bg-restart-"));
    mkdirSync(join(dir, ".state", "scripts"), { recursive: true });
    const live = Bun.spawn(["sleep", "120"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    try {
      const lstart = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(live.pid)]).stdout.toString().trim();
      const startedAt = new Date(Date.now() - 60_000).toISOString();
      const base = { projectPath: PROJECT, status: "running", startedAt, source: "command" };
      writeFileSync(join(dir, ".state", "scripts.json"), JSON.stringify({
        running: [
          { ...base, processId: "dead-cmd", scriptName: "DEAD-JOB", command: "echo", pid: 999999, pidLstart: "gone",
            cmd: { sessionKey: "topic:life", topicId: "topic-life", wake: false } },
          { ...base, processId: "live-cmd", scriptName: "LIVE-JOB", command: "sleep 120", pid: live.pid, pidLstart: lstart,
            cmd: { sessionKey: "topic:life", topicId: "topic-life", wake: true } },
        ],
        recent: [],
      }));
      const out = Bun.spawnSync(["bun", LIFE, "background"], { env: { ...process.env, DATA_DIR: dir, TOPICS_DATA_DIR: dir }, stderr: "pipe" });
      const lines = out.stdout.toString().trim().split("\n");
      const booted = JSON.parse(lines[lines.length - 1] || "{}") as { tasks?: unknown[] };
      expect(booted.tasks).toEqual([{ type: "command", description: "LIVE-JOB", processId: "live-cmd", wakes: true, startedAt: Date.parse(startedAt) }]);
    } finally {
      live.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
