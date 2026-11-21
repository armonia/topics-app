/**
 * The `command` action against a fake runner and a fake clock: outcome and
 * output kept, the time limit, adoption after a restart, a lost process, and
 * the cancellation of a job (T2 of change lavori-programmati-in-topics).
 *
 * @covers SCHED-04
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { addCommandJob, buildEngine, fakeRunner, migratedDb, runsOf } from "./command-test-support";
import { DEFAULT_COMMAND_TIMEOUT_SEC, normalizeCommandAction } from "./command-spec";
import { HISTORY_DAYS } from "./engine";

let db: Database;
const clock = { now: new Date("2026-01-01T00:00:00.000Z") };
const advance = (seconds: number) => { clock.now = new Date(clock.now.getTime() + seconds * 1000); };

beforeEach(() => {
  db = migratedDb();
  clock.now = new Date("2026-01-01T00:00:00.000Z");
});

describe("what a run keeps", () => {
  test("exit code, stdout and stderr are kept apart, stdin and variables reach the runner", () => {
    const { runner, processes, started } = fakeRunner();
    const { engine, action } = buildEngine(db, runner, clock);
    addCommandJob(db, clock, "j1", { action: { stdin: "the job text", env: { GREETING: "ciao" } } });
    engine.tick();
    expect(started).toHaveLength(1);
    expect(started[0].spec).toMatchObject({ jobId: "j1", argv: ["echo", "hi"], stdin: "the job text", env: { GREETING: "ciao" }, timeoutSec: 60, cwd: "/work/dir" });
    const proc = processes.get("proc-1")!;
    proc.stdout = "out text"; proc.stderr = "err text";
    action.ended({ processId: "proc-1", runId: started[0].spec.runId, exitCode: 3, stopped: false, timedOut: false });
    const [run] = runsOf(db, "j1");
    expect(run).toMatchObject({ status: "error", exit_code: 3, stdout_tail: "out text", stderr_tail: "err text" });
  });

  test("an end reported twice closes the run once", () => {
    const { runner, started, processes } = fakeRunner();
    const { engine, action } = buildEngine(db, runner, clock);
    addCommandJob(db, clock, "j1");
    engine.tick();
    processes.get("proc-1")!.stdout = "first";
    const end = { processId: "proc-1", runId: started[0].spec.runId, exitCode: 0, stopped: false, timedOut: false };
    action.ended(end);
    processes.get("proc-1")!.stdout = "second";
    action.ended({ ...end, exitCode: 1 });
    expect(runsOf(db, "j1")[0]).toMatchObject({ status: "ok", exit_code: 0, stdout_tail: "first" });
  });

  test("a job without a directory or a project fails to start instead of running somewhere", () => {
    const { runner, started } = fakeRunner();
    const { engine } = buildEngine(db, runner, clock);
    addCommandJob(db, clock, "j1", { action: { cwd: null } });
    engine.tick();
    expect(started).toHaveLength(0);
    expect(runsOf(db, "j1")[0].status).toBe("failed_to_start");
  });
});

describe("time limit (R13)", () => {
  test("a command without a limit cannot be created, and the default is written on the job", () => {
    expect(() => normalizeCommandAction({ argv: ["true"], timeoutSec: 0 })).toThrow();
    expect(() => normalizeCommandAction({ argv: ["true"], timeoutSec: -5 })).toThrow();
    expect(() => normalizeCommandAction({ argv: ["true"], timeoutSec: "soon" })).toThrow();
    expect(normalizeCommandAction({ argv: ["true"] }).timeoutSec).toBe(DEFAULT_COMMAND_TIMEOUT_SEC);
    expect(DEFAULT_COMMAND_TIMEOUT_SEC).toBe(3600);
  });

  test("past the limit the engine writes `timeout` into SQLite BEFORE it stops the process", () => {
    const fake = fakeRunner();
    const { engine } = buildEngine(db, fake.runner, clock);
    addCommandJob(db, clock, "j1", { action: { timeoutSec: 30 } });
    engine.tick();
    let statusAtStop: unknown = null;
    fake.runner.onStop = () => { statusAtStop = runsOf(db, "j1")[0].status; };
    advance(31);
    engine.tick();
    expect(statusAtStop).toBe("timeout");
    expect(fake.log).toContain("stop:proc-1");
    expect(runsOf(db, "j1")[0].status).toBe("timeout");
  });

  test("a command inside its limit is left alone", () => {
    const fake = fakeRunner();
    const { engine } = buildEngine(db, fake.runner, clock);
    addCommandJob(db, clock, "j1", { action: { timeoutSec: 30 } });
    engine.tick();
    advance(20);
    engine.tick();
    expect(runsOf(db, "j1")[0].status).toBe("running");
    expect(fake.log).toEqual([]);
  });

  test("the limit of the wrapper itself (the engine was down) closes the run as `timeout`", () => {
    const fake = fakeRunner();
    const { engine } = buildEngine(db, fake.runner, clock);
    addCommandJob(db, clock, "j1", { action: { timeoutSec: 30 } });
    engine.tick();
    Object.assign(fake.processes.get("proc-1")!, { exitCode: 143, timedOut: true, life: "dead" });
    advance(40);
    engine.tick();
    expect(runsOf(db, "j1")[0]).toMatchObject({ status: "timeout", exit_code: 143 });
  });
});

describe("a new engine on the same state (R12)", () => {
  test("it adopts a live command and closes it once when its code appears", () => {
    const fake = fakeRunner();
    const first = buildEngine(db, fake.runner, clock);
    addCommandJob(db, clock, "j1");
    first.engine.tick();
    first.engine.stop();
    advance(60);
    const second = buildEngine(db, fake.runner, clock);
    second.engine.tick();
    expect(runsOf(db, "j1")[0].status).toBe("running");
    expect(fake.started).toHaveLength(1);
    Object.assign(fake.processes.get("proc-1")!, { exitCode: 0, life: "dead", stdout: "done" });
    second.engine.tick();
    second.engine.tick();
    expect(runsOf(db, "j1").filter(run => run.status === "ok")).toHaveLength(1);
    expect(runsOf(db, "j1")[0].stdout_tail).toBe("done");
  });

  test("a process provably dead without a code is `interrupted` and starts again ONCE", () => {
    const fake = fakeRunner();
    const { engine } = buildEngine(db, fake.runner, clock);
    addCommandJob(db, clock, "j1", { schedule: { kind: "cron", expr: "0 0 * * *", tz: "UTC" }, nextRunAt: "2026-01-01T00:00:00.000Z" });
    engine.tick();
    fake.processes.get("proc-1")!.life = "dead";
    advance(20);
    engine.tick();
    expect(fake.started).toHaveLength(2);
    const runs = runsOf(db, "j1");
    expect(runs.map(run => [run.occurrence_key.includes("#r1"), run.status])).toEqual([[false, "interrupted"], [true, "running"]]);
    // the retry is lost too: no third start
    fake.processes.get("proc-2")!.life = "dead";
    advance(20);
    engine.tick();
    advance(20);
    engine.tick();
    expect(fake.started).toHaveLength(2);
    expect(runsOf(db, "j1").map(run => run.status)).toEqual(["interrupted", "interrupted"]);
  });

  test("the registry closing a row with no code and no Stop (killed, lost with the machine) is `interrupted` and starts again once", () => {
    const fake = fakeRunner();
    const { engine, action } = buildEngine(db, fake.runner, clock);
    addCommandJob(db, clock, "j1");
    engine.tick();
    action.ended({ processId: "proc-1", runId: fake.started[0].spec.runId, exitCode: null, stopped: false, timedOut: false });
    expect(runsOf(db, "j1").map(run => run.status)).toEqual(["interrupted", "pending"]);
  });

  test("a code written between the first read and the life probe is not a lost command", () => {
    const fake = fakeRunner();
    const { engine } = buildEngine(db, fake.runner, clock);
    addCommandJob(db, clock, "j1");
    engine.tick();
    const proc = fake.processes.get("proc-1")!;
    // The first read finds nothing; by the time the probe runs the command has ended and written its code.
    const firstRead = fake.runner.report;
    let reads = 0;
    fake.runner.report = (processId) => (++reads === 1 ? null : firstRead(processId));
    fake.runner.life = () => { Object.assign(proc, { exitCode: 0, life: "dead" }); return "dead"; };
    advance(20);
    engine.tick();
    expect(runsOf(db, "j1")[0].status).toBe("ok");
    expect(fake.started).toHaveLength(1);
  });

  test("a job marked not repeatable is never started again", () => {
    const fake = fakeRunner();
    const { engine } = buildEngine(db, fake.runner, clock);
    addCommandJob(db, clock, "j1", { policy: { repeatable: false } });
    engine.tick();
    fake.processes.get("proc-1")!.life = "dead";
    advance(20);
    engine.tick();
    expect(fake.started).toHaveLength(1);
    expect(runsOf(db, "j1")[0].status).toBe("interrupted");
  });

  test("when the life probe does not answer, the command is NOT started again", () => {
    const fake = fakeRunner();
    const { engine } = buildEngine(db, fake.runner, clock);
    addCommandJob(db, clock, "j1");
    engine.tick();
    fake.processes.get("proc-1")!.life = "unknown";
    advance(20);
    engine.tick();
    advance(20);
    engine.tick();
    expect(fake.started).toHaveLength(1);
    expect(runsOf(db, "j1")[0].status).toBe("running");
  });

  test("a live group of a job that no run owns (its row was lost) is reconciled: stopped", () => {
    const fake = fakeRunner();
    const { engine } = buildEngine(db, fake.runner, clock);
    fake.processes.set("orphan-1", { life: "alive", exitCode: null, timedOut: false, stdout: "", stderr: "", stopped: false });
    engine.tick();
    expect(fake.log).toEqual(["stop:orphan-1"]);
  });
});

describe("a job that is cancelled or deleted (R25)", () => {
  test("its run in flight is stopped and ends `cancelled`, with no later closing over it", () => {
    const fake = fakeRunner();
    const { engine, action } = buildEngine(db, fake.runner, clock);
    addCommandJob(db, clock, "j1");
    engine.tick();
    expect(engine.cancelOpenRuns("j1", "The job was deleted.")).toBe(1);
    expect(fake.log).toEqual(["stop:proc-1"]);
    action.ended({ processId: "proc-1", runId: fake.started[0].spec.runId, exitCode: 143, stopped: true, timedOut: false });
    expect(runsOf(db, "j1")[0]).toMatchObject({ status: "cancelled", reason: "The job was deleted." });
  });
});

describe("history (R14)", () => {
  test("runs older than 30 days go, newer ones stay", () => {
    const { runner } = fakeRunner();
    const { engine } = buildEngine(db, runner, clock);
    addCommandJob(db, clock, "j1", { nextRunAt: "2027-01-01T00:00:00.000Z" });
    const old = new Date(clock.now.getTime() - (HISTORY_DAYS + 1) * 86_400_000).toISOString();
    const recent = new Date(clock.now.getTime() - 86_400_000).toISOString();
    for (const [key, at] of [["old", old], ["recent", recent]]) {
      db.prepare("INSERT INTO scheduled_job_runs (id, job_id, occurrence_key, scheduled_for, status, created_at, finished_at) VALUES (?, 'j1', ?, ?, 'ok', ?, ?)").run(key, key, at, at, at);
    }
    engine.tick();
    expect(runsOf(db, "j1").map(run => run.id)).toEqual(["recent"]);
  });
});
