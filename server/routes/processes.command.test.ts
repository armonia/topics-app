/**
 * `run_command` on the registry: any command, in the topic's project, as a
 * process row the panel draws with its log, its status, its Stop and, once it
 * ends, its outcome. Real spawns, short commands.
 *
 * @covers CMDRUN-01, CMDRUN-02
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// The registry fixes its state folder at import: this file gets its own when
// it is the first to load it, and hands DATA_DIR back to the files after it.
const STATE = mkdtempSync(join(tmpdir(), "topics-cmd-state-"));
const previousDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = STATE;
const { createProcessesRouter, listOwnedScripts } = await import("./processes");
if (previousDataDir === undefined) delete process.env.DATA_DIR;
else process.env.DATA_DIR = previousDataDir;

const PROJECT = realpathSync(mkdtempSync(join(tmpdir(), "topics-cmd-project-")));
mkdirSync(join(PROJECT, "sub"));
// A link inside the project that points out of it: the third way out.
symlinkSync(tmpdir(), join(PROJECT, "out"));
writeFileSync(join(PROJECT, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
// STATE stays: when this file loaded the registry first, it is the registry's
// folder for every file after it in the same process, and a command started
// there opens its log in it. Removing it made the next file's commands fail.
afterAll(() => rmSync(PROJECT, { recursive: true, force: true }));

const TOPIC = { id: "topic-cmd", sessionKey: "topic:cmd" };

function makeRouter(opts: { globalSessionKey?: string } = {}) {
  const ctx = {
    db: {
      query: (sql: string) => ({
        get: (_scope: string, sessionKey: string) =>
          sql.includes("topics.session_key") && sessionKey === opts.globalSessionKey
            ? { scope: "global", topic_id: TOPIC.id, created_at: "x", updated_at: "x" }
            : null,
      }),
    },
    json: (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
    broadcastToAll: () => {},
    getTopicBySessionKey: (k: string) => (k === TOPIC.sessionKey || k === opts.globalSessionKey ? TOPIC : null),
    resolveTopicCwd: () => PROJECT,
  };
  return createProcessesRouter(ctx as never);
}

async function call(router: ReturnType<typeof makeRouter>, method: string, path: string, body?: unknown) {
  const url = new URL(`http://x${path}`);
  const req = new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return (await router(req, url, url.pathname, method))!;
}

const run = (router: ReturnType<typeof makeRouter>, body: unknown, sessionKey = TOPIC.sessionKey) =>
  call(router, "POST", `/api/sessions/${encodeURIComponent(sessionKey)}/commands/run`, body);

type Row = { processId: string; source: string; status: string; exitCode?: number; topicId?: string; stopped?: boolean; command: string };
async function rowOf(router: ReturnType<typeof makeRouter>, processId: string): Promise<Row | undefined> {
  const { scripts } = await (await call(router, "GET", `/api/sessions/${encodeURIComponent(TOPIC.sessionKey)}/scripts`)).json() as { scripts: Row[] };
  return scripts.find((s) => s.processId === processId);
}
async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v) || Date.now() > end) return v;
    await Bun.sleep(100);
  }
}
async function logOf(router: ReturnType<typeof makeRouter>, processId: string): Promise<string> {
  const body = await (await call(router, "GET", `/api/scripts/${processId}/output`)).json() as { output: string; pending?: string };
  return body.output + (body.pending ?? "");
}

describe("POST /api/sessions/:sessionKey/commands/run", () => {
  test("the command starts and becomes a running row of the topic", async () => {
    const router = makeRouter();
    const resp = await run(router, { command: "echo tick 1; sleep 1; echo tick 2" });
    expect(resp.status).toBe(200);
    const { processId } = await resp.json() as { processId: string };
    expect(processId).toBeTruthy();

    const row = await rowOf(router, processId);
    expect(row).toMatchObject({ source: "command", topicId: TOPIC.id, status: "running" });

    const done = await until(() => rowOf(router, processId), (r) => r?.status !== "running");
    expect(done).toMatchObject({ status: "done", exitCode: 0 });
    const log = await logOf(router, processId);
    expect(log).toContain("tick 1");
    expect(log).toContain("tick 2");
  });

  test("the outcome stays readable: exit 3 keeps the row, and its log", async () => {
    const router = makeRouter();
    const { processId } = await (await run(router, { command: "echo tick 1; echo tick 2; exit 3" })).json() as { processId: string };
    const row = await until(() => rowOf(router, processId), (r) => r?.status !== "running");
    expect(row).toMatchObject({ source: "command", status: "error", exitCode: 3 });
    expect(await logOf(router, processId)).toContain("tick 2");
  });

  test("it runs in the project, or in a directory inside it", async () => {
    const router = makeRouter();
    const a = await (await run(router, { command: "pwd" })).json() as { processId: string };
    const b = await (await run(router, { command: "pwd", cwd: "sub" })).json() as { processId: string };
    await until(() => rowOf(router, b.processId), (r) => r?.status !== "running");
    await until(() => rowOf(router, a.processId), (r) => r?.status !== "running");
    expect((await logOf(router, a.processId)).trim()).toBe(PROJECT);
    expect((await logOf(router, b.processId)).trim()).toBe(join(PROJECT, "sub"));
  });

  test("a cwd outside the project launches nothing", async () => {
    const router = makeRouter();
    const before = (await (await call(router, "GET", "/api/scripts")).json() as { scripts: unknown[] }).scripts.length;
    for (const cwd of ["../..", "/", tmpdir(), "missing-dir", "out"]) {
      const resp = await run(router, { command: "touch escaped", cwd });
      expect(resp.status).toBe(400);
    }
    const after = (await (await call(router, "GET", "/api/scripts")).json() as { scripts: unknown[] }).scripts.length;
    expect(after).toBe(before);
  });

  test("an empty command is refused", async () => {
    expect((await run(makeRouter(), {})).status).toBe(400);
    expect((await run(makeRouter(), { command: "   " })).status).toBe(400);
  });

  test("the global coordinator has no folder to run it in", async () => {
    const router = makeRouter({ globalSessionKey: "global-session" });
    const resp = await run(router, { command: "echo no" }, "global-session");
    expect(resp.status).toBe(403);
    expect(await resp.json()).toMatchObject({ code: "orchestrator_topic_invariant" });
  });

  test("run_script stays closed to anything undeclared", async () => {
    const resp = await call(makeRouter(), "POST", `/api/sessions/${encodeURIComponent(TOPIC.sessionKey)}/scripts/run`, { scriptName: "echo hi" });
    expect(resp.status).toBe(400);
    expect((await resp.json() as { available: string[] }).available).toEqual(["package.json#dev"]);
  });

  // The worktree guards (the GC's «something alive inside», the eviction before
  // a removal, the ghost reaper) all read this list: a command missing from it
  // let a worktree be slimmed, committed or removed while it ran in there.
  test("a running command is one of Topics' own processes for the worktree guards", async () => {
    const router = makeRouter();
    const { processId, pid } = await (await run(router, { command: "sleep 5" })).json() as { processId: string; pid: number };
    try {
      expect(listOwnedScripts().find((s) => s.processId === processId)).toMatchObject({
        pid, projectPath: PROJECT, source: "command", status: "running",
      });
    } finally {
      await call(router, "POST", `/api/scripts/${processId}/stop`);
      await until(() => rowOf(router, processId), (r) => r?.status !== "running");
    }
    expect(listOwnedScripts().find((s) => s.processId === processId)).toBeUndefined();
  });

  test("Stop ends the command and its children, and the row says stopped", async () => {
    const router = makeRouter();
    const { processId, pid } = await (await run(router, { command: "sleep 30 & sleep 30; wait" })).json() as { processId: string; pid: number };
    await until(() => rowOf(router, processId), (r) => r?.status === "running");
    const stop = await call(router, "POST", `/api/scripts/${processId}/stop`);
    expect(stop.status).toBe(200);

    const row = await until(() => rowOf(router, processId), (r) => r?.status !== "running");
    expect(row).toMatchObject({ source: "command", status: "error", stopped: true });
    // Its own process group: nothing of it is left.
    const group = await until(
      async () => Bun.spawnSync(["pgrep", "-g", String(pid)]).stdout.toString().trim(),
      (out) => out === "",
    );
    expect(group).toBe("");
  });
});
