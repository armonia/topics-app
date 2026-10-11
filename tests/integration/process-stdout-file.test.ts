/**
 * A `run_command` that sends its stdout to a file it names (chat-live-work):
 * its log follows that file while it runs, keeps what it read when it ends,
 * and reads it again after a reload of the server, like its own log
 * (CMDRUN-03). The reload is two processes on one state folder, as in
 * `process-run-command.test.ts` (`helpers/process-registry-life.ts`).
 *
 * Muse, 07/10: `freeagent … > /tmp/fa-wallrunv2.log 2>&1` ran 58 minutes with
 * its row on «Waiting for output...»: everything it printed went to that file.
 *
 * @covers CMDRUN-03
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { join } from "path";
import { setupTestDataDir, testTmpDir } from "./helpers";

const ROOT = testTmpDir("process-stdout-file");
// Before the registry is first used: its load reads the state folder named then.
setupTestDataDir(join(ROOT, "data"));
const PROJECT = realpathSync((mkdirSync(join(ROOT, "project"), { recursive: true }), join(ROOT, "project")));
const TOPIC = { id: "topic-stdout", sessionKey: "topic:stdout" };

const { createProcessesRouter, logPathOf } = await import("../../server/routes/processes");
const router = createProcessesRouter({
  db: { query: () => ({ get: () => null }) },
  json: (d: unknown, status = 200) => new Response(JSON.stringify(d), { status }),
  broadcastToAll: () => {},
  getTopicBySessionKey: (k: string) => (k === TOPIC.sessionKey ? TOPIC : null),
  resolveTopicCwd: () => PROJECT,
} as never);

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const url = new URL(`http://topics.test${path}`);
  const req = new Request(url, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return (await router(req, url, url.pathname, method))!;
}
async function until(ok: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await ok()) && Date.now() < end) await Bun.sleep(50);
}

type Out = { output: string; pending: string; follows?: string; unfollowed?: { target: string; reason: string } };
const outputOf = async (processId: string) => (await (await call("GET", `/api/scripts/${processId}/output`)).json()) as Out;
const statusOf = async (processId: string) =>
  ((await (await call("GET", "/api/scripts")).json()) as { scripts: Array<{ processId: string; status: string }> }).scripts.find((s) => s.processId === processId)?.status;
const runQuiet = async (command: string) => ((await (await call("POST",
  `/api/sessions/${encodeURIComponent(TOPIC.sessionKey)}/commands/run`, { command, wake: false })).json()) as { processId: string }).processId;
let files = 0;
const fileIn = () => join(ROOT, `stdout-${++files}.log`);

describe("a command that sends its stdout to a file it names", () => {
  test("its log follows that file while it runs, and keeps what it read when it ends", async () => {
    const file = fileIn();
    const processId = await runQuiet(`for i in 1 2 3 4 5 6 7 8; do echo tick $i; sleep 0.5; done > ${file} 2>&1; echo own line`);
    await until(async () => (await outputOf(processId)).output.includes("tick 1"), 3000);
    const live = await outputOf(processId);
    expect(live.output).toContain("tick 1");
    expect(live.follows).toBe(file);
    expect(await statusOf(processId)).toBe("running");

    await until(async () => (await statusOf(processId)) !== "running");
    const lines = "tick 1\ntick 2\ntick 3\ntick 4\ntick 5\ntick 6\ntick 7\ntick 8\nown line";
    expect((await outputOf(processId)).output).toContain(lines);
    // A reload reads the log alone: what went to the file is in it too.
    expect(readFileSync(logPathOf(processId), "utf8")).toContain(lines);
  }, 20_000);

  test("a file it appends to: only what this run adds", async () => {
    const file = fileIn();
    writeFileSync(file, "an earlier run\n");
    const processId = await runQuiet(`echo this run >> ${file}`);
    await until(async () => (await statusOf(processId)) !== "running");
    const { output } = await outputOf(processId);
    expect(output).toContain("this run");
    expect(output).not.toContain("an earlier run");
  });

  test("a file only the shell can name: said, not followed", async () => {
    const file = fileIn();
    const processId = await runQuiet(`LOG=${file}; echo hidden > "$LOG"`);
    await until(async () => (await statusOf(processId)) !== "running");
    const out = await outputOf(processId);
    expect(out.unfollowed).toEqual({ target: "$LOG", reason: "variable" });
    expect(out.follows).toBeUndefined();
    expect(out.output).not.toContain("hidden");
    expect(readFileSync(file, "utf8")).toBe("hidden\n");
  });
});

describe("the file outlives the server too", () => {
  const LIFE = join(import.meta.dir, "helpers", "process-registry-life.ts");
  const state = join(ROOT, "life");
  mkdirSync(state, { recursive: true });
  const dbPath = join(state, "wakes.db");
  const db = new Database(dbPath);
  // The columns of the real table the wake writes into.
  db.run("CREATE TABLE messages (id TEXT, session_key TEXT, role TEXT, content TEXT, blocks TEXT, parent_id TEXT, timestamp TEXT)");
  db.close();

  /** One life of the registry on the state folder; its last line is JSON (see the helper). */
  function life(...args: string[]): Record<string, any> {
    const out = Bun.spawnSync(["bun", LIFE, ...args], { env: { ...process.env, DATA_DIR: state, TOPICS_DATA_DIR: state }, stderr: "pipe" });
    const lines = out.stdout.toString().trim().split("\n");
    return lines[lines.length - 1] ? JSON.parse(lines[lines.length - 1]!) : {};
  }
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  test("a reload mid-run: the file is read again from the run's start and followed on", () => {
    const file = join(state, `stdout-${Date.now()}.log`);
    const started = life("start", PROJECT, `{ echo tick 1; sleep 3; echo tick 2; } > ${file}`);
    const booted = life("boot", PROJECT, started.processId, dbPath);
    expect(booted.row).toMatchObject({ processId: started.processId, status: "done", exitCode: 0 });
    expect(booted.log).toContain("tick 1\ntick 2"); // the first before the reload, the second after
    expect(booted.log.match(/tick 1/g)).toHaveLength(1);
  }, 40_000);

  test("it ended while the server was down: the file is in the log the boot closes, and only once", async () => {
    const file = join(state, `stdout-${Date.now()}.log`);
    const started = life("start", PROJECT, `{ echo tick 1; echo tick 2; } > ${file}`);
    await until(() => existsSync(join(state, ".state", "scripts", `${started.processId}.exit`)));
    await until(() => !alive(started.pid));

    expect(life("boot", PROJECT, started.processId, dbPath).log).toContain("tick 1\ntick 2");
    // The next boot reads the log alone, which the first one completed.
    expect(life("boot", PROJECT, started.processId, dbPath).log.match(/tick 2/g)).toHaveLength(1);
  }, 40_000);
});
