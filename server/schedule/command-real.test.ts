/**
 * Scheduled commands for real: short commands spawned through the registry of
 * processes, the exit code, stdout and stderr read back, the time limit, a
 * Stop, and a second engine adopting a command the first one started. Needs a
 * POSIX shell: skipped where there is none.
 *
 * @covers SCHED-04
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The registry keeps its state in the folder DATA_DIR names: this file's own, handed back afterwards.
const STATE = mkdtempSync(join(tmpdir(), "topics-job-state-"));
const WORK = realpathSync(mkdtempSync(join(tmpdir(), "topics-job-work-")));
const previousDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = STATE;
const { hasCommandShell } = await import("../lib/command-process");
const { createRegistryRunner } = await import("./command-runner");
const { processGroupAlive, commandProcessGroup } = await import("../lib/command-process-groups");
const { addCommandJob, buildEngine, migratedDb, runsOf } = await import("./command-test-support");
const { runningScripts } = await import("../routes/processes-state");

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  rmSync(STATE, { recursive: true, force: true });
  rmSync(WORK, { recursive: true, force: true });
});

const realClock = { get now() { return new Date(); } } as { now: Date };
const real = test.skipIf(!hasCommandShell());

/** Ticks until the job's first run leaves `running`, or the time is up. */
async function settle(engine: { tick(): unknown }, db: ReturnType<typeof migratedDb>, jobId: string, seconds = 20) {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    engine.tick();
    const [run] = runsOf(db, jobId);
    if (run && !["pending", "starting", "running"].includes(run.status)) return run;
    await Bun.sleep(300);
  }
  return runsOf(db, jobId)[0];
}

function wire(db: ReturnType<typeof migratedDb>) {
  const runner = createRegistryRunner();
  const built = buildEngine(db, runner, realClock);
  runner.onEnd((end) => built.action.ended(end));
  return { runner, ...built };
}

describe("scheduled commands on the registry", () => {
  real("stdin arrives, stdout and stderr are kept apart, the variables of the job are there, the code is read", async () => {
    const db = migratedDb();
    const { engine } = wire(db);
    addCommandJob(db, realClock, "j1", { action: { cwd: WORK, stdin: "hello", env: { MY_VAR: "v1" }, argv: ["sh", "-c", 'cat; echo " $TOPICS_JOB_ID $MY_VAR"; echo problem >&2; exit 0'] } });
    const run = await settle(engine, db, "j1");
    expect(run.status).toBe("ok");
    expect(run.exit_code).toBe(0);
    expect(run.stdout_tail).toContain("hello");
    expect(run.stdout_tail).toContain("j1 v1");
    expect(run.stderr_tail).toBe("problem\n");
    expect(run.stdout_tail).not.toContain("problem");
  }, 30_000);

  real("a failing command ends in error with its code", async () => {
    const db = migratedDb();
    const { engine } = wire(db);
    addCommandJob(db, realClock, "j1", { action: { cwd: WORK, argv: ["sh", "-c", "echo partial; exit 7"] } });
    const run = await settle(engine, db, "j1");
    expect(run).toMatchObject({ status: "error", exit_code: 7 });
    expect(run.stdout_tail).toContain("partial");
  }, 30_000);

  real("a command over its time limit is stopped and the run is `timeout`", async () => {
    const db = migratedDb();
    const { engine } = wire(db);
    addCommandJob(db, realClock, "j1", { action: { cwd: WORK, argv: ["sleep", "30"], timeoutSec: 1 } });
    const run = await settle(engine, db, "j1");
    expect(run.status).toBe("timeout");
  }, 30_000);

  real("deleting the job stops the group and the run is `cancelled`", async () => {
    const db = migratedDb();
    const { engine } = wire(db);
    addCommandJob(db, realClock, "j1", { action: { cwd: WORK, argv: ["sleep", "30"] } });
    engine.tick();
    const [started] = runsOf(db, "j1");
    expect(started.status).toBe("running");
    expect(started.process_ref).not.toBeNull();
    const group = commandProcessGroup(started.process_ref!)!;
    expect(processGroupAlive(group.pgid)).toBe(true);
    engine.cancelOpenRuns("j1", "The job was deleted.");
    const until = Date.now() + 15_000;
    while (processGroupAlive(group.pgid) && Date.now() < until) await Bun.sleep(200);
    expect(processGroupAlive(group.pgid)).toBe(false);
    expect(runsOf(db, "j1")[0].status).toBe("cancelled");
  }, 30_000);

  real("a second engine on the same state adopts a live command and closes it once", async () => {
    const db = migratedDb();
    const first = wire(db);
    addCommandJob(db, realClock, "j1", { action: { cwd: WORK, argv: ["sh", "-c", "sleep 2; echo late"] } });
    first.engine.tick();
    first.engine.stop();
    // The first engine and its registry row are gone, as after a restart: the group and the files remain.
    runningScripts.clear();
    const second = wire(db);
    const run = await settle(second.engine, db, "j1");
    expect(run).toMatchObject({ status: "ok", exit_code: 0 });
    expect(run.stdout_tail).toContain("late");
    expect(runsOf(db, "j1")).toHaveLength(1);
  }, 30_000);
});
