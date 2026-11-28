/**
 * The engine on a fake clock: lost occurrences, windows, overlap, the cap, two engines
 * on one file, a launch that fails, the card in the run's transaction, the shutdown.
 *
 * @covers SCHED-01, SCHED-02, SCHED-03
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobSchedule } from "../../shared/schedule";
import { createCardAction } from "./card-action";
import { createScheduleEngine, type ActionExecutor, type StartResult } from "./engine";
import type { JobAction } from "./store";
import { createTaskService } from "../services/tasks";
import { freshDb, PID } from "../services/tasks-test-db";

const MIGRATIONS = join(import.meta.dir, "../db/migrations");
const migrate = (db: Database) => {
  for (const file of ["20261014225051-scheduled-cards.sql", "20261121105631-scheduled-jobs.sql", "20261126180000-scheduled-delivery-guards.sql"]) db.run(readFileSync(join(MIGRATIONS, file), "utf8"));
};

let db: Database;
let clock: Date;
const setClock = (iso: string) => { clock = new Date(iso); };

/** A command-like executor: it counts launches and stays `running` until the test finishes it. */
function fakeCommand(behaviour: "run" | "fail" = "run") {
  const launched: string[] = [];
  const executor: ActionExecutor = {
    atomic: false,
    start(_job, run): StartResult {
      if (behaviour === "fail") throw new Error("spawn failed");
      launched.push(run.occurrenceKey);
      return { status: "running", processRef: `proc-${launched.length}` };
    },
  };
  return { executor, launched };
}

function addJob(id: string, schedule: JobSchedule, action: JobAction, nextRunAt: string, projectId: string | null = PID) {
  db.prepare(`INSERT INTO scheduled_jobs (id, name, project_id, schedule_json, action_json, enabled, next_run_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`).run(id, id, projectId, JSON.stringify(schedule), JSON.stringify(action), nextRunAt, clock.toISOString(), clock.toISOString());
}
const runs = (jobId: string) => db.query("SELECT * FROM scheduled_job_runs WHERE job_id = ? ORDER BY scheduled_for, occurrence_key").all(jobId) as Array<Record<string, unknown>>;
const statuses = (jobId: string) => runs(jobId).map(r => r.status);
const nextRun = (jobId: string) => (db.query("SELECT next_run_at FROM scheduled_jobs WHERE id = ?").get(jobId) as { next_run_at: string | null }).next_run_at;
const COMMAND: JobAction = { kind: "command", argv: ["echo"], stdin: null, cwd: null, env: {}, timeoutSec: 60 };

beforeEach(() => {
  db = freshDb();
  migrate(db);
  setClock("2026-01-01T00:00:00.000Z");
});

describe("every without drift", () => {
  test("next = scheduled_for + N over 100 runs even when every tick is late", () => {
    const { executor } = fakeCommand();
    const engine = createScheduleEngine(db, { executors: { command: executor }, now: () => clock });
    addJob("j", { kind: "every", minutes: 10 }, COMMAND, "2026-01-01T00:10:00.000Z");
    for (let i = 0; i < 100; i++) {
      // each tick lands 3 minutes after the slot
      setClock(new Date(Date.parse("2026-01-01T00:10:00.000Z") + i * 600_000 + 180_000).toISOString());
      engine.tick();
      const [run] = (db.query("SELECT id FROM scheduled_job_runs WHERE status = 'running'").all() as { id: string }[]);
      if (run) engine.finishRun(run.id, "ok");
    }
    const keys = runs("j").map(r => r.scheduled_for);
    expect(keys).toHaveLength(100);
    keys.forEach((key, i) => expect(key).toBe(new Date(Date.parse("2026-01-01T00:10:00.000Z") + i * 600_000).toISOString()));
    expect(nextRun("j")).toBe(new Date(Date.parse("2026-01-01T00:10:00.000Z") + 100 * 600_000).toISOString());
  });
});

describe("two engines on one file", () => {
  test("one run and one launch, also for a row left pending", () => {
    const dir = mkdtempSync(join(tmpdir(), "sched-"));
    const file = join(dir, "t.db");
    const a = new Database(file); const b = new Database(file);
    try {
      a.run("PRAGMA journal_mode = WAL");
      a.run("CREATE TABLE tasks (id TEXT PRIMARY KEY)");
      for (const file of ["20261014225051-scheduled-cards.sql", "20261121105631-scheduled-jobs.sql", "20261126180000-scheduled-delivery-guards.sql"]) a.run(readFileSync(join(MIGRATIONS, file), "utf8").replace(/REFERENCES tasks\(id\)[^,\n]*/g, ""));
      b.run("PRAGMA busy_timeout = 2000");
      const first = fakeCommand(); const second = fakeCommand();
      const engineB = createScheduleEngine(b, { executors: { command: second.executor }, now: () => clock });
      // Engine A has read the pending row; before it launches it, engine B (a second server) launches it.
      let raced = false;
      const engineA = createScheduleEngine(a, {
        executors: { command: first.executor }, now: () => clock,
        maxConcurrent: () => { if (!raced) { raced = true; engineB.tick(); } return 4; },
      });
      a.prepare(`INSERT INTO scheduled_jobs (id, name, schedule_json, action_json, enabled, next_run_at, created_at, updated_at)
        VALUES ('j', 'j', ?, ?, 1, '2026-01-01T00:00:00.000Z', 'x', 'x')`).run(JSON.stringify({ kind: "cron", expr: "0 * * * *", tz: "UTC" }), JSON.stringify(COMMAND));
      // The occurrence is taken by one engine and left pending (a crash before the launch)...
      a.prepare(`INSERT INTO scheduled_job_runs (id, job_id, occurrence_key, scheduled_for, status, created_at) VALUES ('r1', 'j', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'pending', 'x')`).run();
      // ...and both engines tick on it, interleaved.
      engineA.tick();
      expect(first.launched.length + second.launched.length).toBe(1);
      expect((a.query("SELECT COUNT(*) AS n FROM scheduled_job_runs").get() as { n: number }).n).toBe(1);
      // The same due occurrence seen by both: still one run.
      a.prepare("UPDATE scheduled_jobs SET next_run_at = '2026-01-01T00:00:00.000Z'").run();
      engineB.tick(); engineA.tick();
      expect((a.query("SELECT COUNT(*) AS n FROM scheduled_job_runs").get() as { n: number }).n).toBe(1);
    } finally { a.close(); b.close(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows keeps the file locked a moment longer; the temp dir is the OS's to clean */ } }
  });
});

describe("states", () => {
  test("a launch that fails is failed_to_start and the next occurrence runs anyway", () => {
    const bad = fakeCommand("fail");
    let engine = createScheduleEngine(db, { executors: { command: bad.executor }, now: () => clock });
    addJob("j", { kind: "cron", expr: "0 * * * *", tz: "UTC" }, COMMAND, "2026-01-01T01:00:00.000Z");
    setClock("2026-01-01T01:00:10.000Z");
    engine.tick();
    expect(statuses("j")).toEqual(["failed_to_start"]);
    const good = fakeCommand();
    engine = createScheduleEngine(db, { executors: { command: good.executor }, now: () => clock });
    setClock("2026-01-01T02:00:10.000Z");
    engine.tick();
    expect(statuses("j")).toEqual(["failed_to_start", "running"]);
  });

  test("a starting row without a process after a minute does not block the next ones", () => {
    const { executor } = fakeCommand();
    const engine = createScheduleEngine(db, { executors: { command: executor }, now: () => clock });
    addJob("j", { kind: "every", minutes: 10 }, COMMAND, "2026-01-01T01:00:00.000Z");
    db.prepare(`INSERT INTO scheduled_job_runs (id, job_id, occurrence_key, scheduled_for, status, created_at, started_at) VALUES ('r', 'j', 'old', '2026-01-01T00:50:00.000Z', 'starting', 'x', '2026-01-01T00:59:00.000Z')`).run();
    setClock("2026-01-01T01:00:30.000Z");
    engine.tick();
    expect(statuses("j")).toContain("failed_to_start");
    expect(statuses("j")).toContain("running");
  });
});

describe("lost occurrences", () => {
  test("3 hours down: a cron inside 6 hours runs once; an every 10 runs once and leaves one missed row with the count", () => {
    const { executor } = fakeCommand();
    const engine = createScheduleEngine(db, { executors: { command: executor }, now: () => clock });
    addJob("cron", { kind: "cron", expr: "0 * * * *", tz: "UTC" }, COMMAND, "2026-01-01T01:00:00.000Z");
    addJob("every", { kind: "every", minutes: 10 }, COMMAND, "2026-01-01T01:00:00.000Z");
    setClock("2026-01-01T04:05:00.000Z");
    engine.tick();
    expect(runs("cron").filter(r => r.status === "running").map(r => r.scheduled_for)).toEqual(["2026-01-01T04:00:00.000Z"]);
    expect(runs("cron").find(r => r.status === "missed")).toMatchObject({ missed_count: 3, cause: "down" });
    expect(runs("every").filter(r => r.status === "running")).toHaveLength(1);
    expect(runs("every").filter(r => r.status === "missed")).toHaveLength(1);
    expect(runs("every").find(r => r.status === "missed")?.missed_count).toBe(18);
    // and the job goes on at the first slot after now
    expect(nextRun("every")).toBe("2026-01-01T04:10:00.000Z");
    expect(nextRun("cron")).toBe("2026-01-01T05:00:00.000Z");
  });

  test("a cron command beyond the 6 hour window is only counted as missed", () => {
    const { executor, launched } = fakeCommand();
    const engine = createScheduleEngine(db, { executors: { command: executor }, now: () => clock });
    addJob("j", { kind: "cron", expr: "0 8 * * *", tz: "UTC" }, COMMAND, "2026-01-01T08:00:00.000Z");
    setClock("2026-01-01T20:00:00.000Z");
    engine.tick();
    expect(launched).toHaveLength(0);
    expect(statuses("j")).toEqual(["missed"]);
    expect(nextRun("j")).toBe("2026-01-02T08:00:00.000Z");
  });

  test("an at runs once within 24 hours, never twice, and is then off", () => {
    const { executor, launched } = fakeCommand();
    const engine = createScheduleEngine(db, { executors: { command: executor }, now: () => clock });
    addJob("j", { kind: "at", at: "2026-01-01T08:00:00.000Z" }, COMMAND, "2026-01-01T08:00:00.000Z");
    setClock("2026-01-01T20:00:00.000Z");
    engine.tick(); engine.tick();
    expect(launched).toHaveLength(1);
    expect(db.query("SELECT enabled, next_run_at FROM scheduled_jobs WHERE id = 'j'").get()).toEqual({ enabled: 0, next_run_at: null });
  });
});

describe("overlap and cap", () => {
  test("a cron that is still running when due is skipped (overlap)", () => {
    const { executor, launched } = fakeCommand();
    const engine = createScheduleEngine(db, { executors: { command: executor }, now: () => clock });
    addJob("j", { kind: "cron", expr: "0 * * * *", tz: "UTC" }, COMMAND, "2026-01-01T01:00:00.000Z");
    setClock("2026-01-01T01:00:05.000Z"); engine.tick();
    setClock("2026-01-01T02:00:05.000Z"); engine.tick();
    expect(launched).toHaveLength(1);
    expect(runs("j").map(r => [r.status, r.cause])).toEqual([["running", null], ["skipped", "overlap"]]);
  });

  test("an every that overruns restarts as soon as the run ends", () => {
    const { executor, launched } = fakeCommand();
    const engine = createScheduleEngine(db, { executors: { command: executor }, now: () => clock });
    addJob("j", { kind: "every", minutes: 10 }, COMMAND, "2026-01-01T01:00:00.000Z");
    setClock("2026-01-01T01:00:05.000Z"); engine.tick();
    setClock("2026-01-01T01:12:00.000Z"); engine.tick(); // slot 01:10 is due, previous run still open
    expect(launched).toHaveLength(1);
    const open = db.query("SELECT id FROM scheduled_job_runs WHERE status = 'running'").get() as { id: string };
    setClock("2026-01-01T01:13:00.000Z");
    engine.finishRun(open.id, "ok");
    expect(launched).toHaveLength(2);
  });

  test("20 jobs due at once start in steps, capped", () => {
    const { executor, launched } = fakeCommand();
    const engine = createScheduleEngine(db, { executors: { command: executor }, now: () => clock, maxConcurrent: () => 4 });
    for (let i = 0; i < 20; i++) addJob(`j${i}`, { kind: "cron", expr: "0 * * * *", tz: "UTC" }, COMMAND, "2026-01-01T01:00:00.000Z");
    setClock("2026-01-01T01:00:05.000Z");
    engine.tick();
    expect(launched).toHaveLength(4);
    expect(db.query("SELECT COUNT(*) AS n FROM scheduled_job_runs WHERE status = 'pending'").get()).toEqual({ n: 16 });
    const open = db.query("SELECT id FROM scheduled_job_runs WHERE status = 'running'").all() as { id: string }[];
    for (const row of open) engine.finishRun(row.id, "ok");
    expect(launched.length).toBeGreaterThan(4);
    expect(launched.length).toBeLessThanOrEqual(8);
  });
});

describe("card action", () => {
  const cardAction = (): JobAction => ({ kind: "card", text: "Check the deploy", status: "backlog", labels: [] });
  const wire = () => createScheduleEngine(db, { executors: { card: createCardAction(db, createTaskService(db, { now: () => clock.toISOString() })) }, now: () => clock });
  const taskCount = () => (db.query("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n;

  test("three weeks of downtime make one card; the previous card still open skips the next", () => {
    const engine = wire();
    addJob("j", { kind: "cron", expr: "0 9 * * 1", tz: "UTC" }, cardAction(), "2026-01-05T09:00:00.000Z");
    setClock("2026-01-26T10:00:00.000Z");
    expect(engine.tick().created).toHaveLength(1);
    expect(taskCount()).toBe(1);
    expect(runs("j").find(r => r.status === "missed")?.missed_count).toBe(3);
    setClock("2026-02-02T10:00:00.000Z");
    expect(engine.tick().created).toHaveLength(0);
    expect(taskCount()).toBe(1);
    expect(runs("j").at(-1)).toMatchObject({ status: "skipped", cause: "overlap" });
  });

  test("the card and its run are one transaction: a failing card leaves no run behind it ok", () => {
    const failing: ActionExecutor = { atomic: true, start() { throw new Error("no board"); } };
    const engine = createScheduleEngine(db, { executors: { card: failing }, now: () => clock });
    addJob("j", { kind: "cron", expr: "0 9 * * 1", tz: "UTC" }, cardAction(), "2026-01-05T09:00:00.000Z");
    setClock("2026-01-05T09:00:05.000Z");
    engine.tick();
    expect(statuses("j")).toEqual(["failed_to_start"]);
    expect(taskCount()).toBe(0);
  });

  test("a run with a card links to it", () => {
    const engine = wire();
    addJob("j", { kind: "cron", expr: "0 9 * * 1", tz: "UTC" }, cardAction(), "2026-01-05T09:00:00.000Z");
    setClock("2026-01-05T09:00:05.000Z");
    const [taskId] = engine.tick().created;
    expect(runs("j")[0]).toMatchObject({ status: "ok", task_id: taskId });
  });
});

describe("shutdown", () => {
  test("after stop no run starts, and the heartbeat is written by every tick before that", () => {
    const { executor, launched } = fakeCommand();
    const engine = createScheduleEngine(db, { executors: { command: executor }, now: () => clock });
    addJob("j", { kind: "every", minutes: 10 }, COMMAND, "2026-01-01T00:10:00.000Z");
    setClock("2026-01-01T00:00:30.000Z");
    engine.tick();
    expect(db.query("SELECT last_tick_at FROM scheduled_engine_state WHERE id = 1").get()).toEqual({ last_tick_at: "2026-01-01T00:00:30.000Z" });
    engine.stop();
    setClock("2026-01-01T00:11:00.000Z");
    engine.tick();
    expect(launched).toHaveLength(0);
    expect(runs("j")).toHaveLength(0);
  });
});

afterEach(() => { db.close(); });

describe("a job with broken data (review finding)", () => {
  test("does not hold back the healthy ones", () => {
    setClock("2026-03-02T10:00:00Z");
    const executor = fakeCommand();
    const engine = createScheduleEngine(db, { executors: { command: executor.executor }, now: () => clock });
    addJob("bad", { kind: "cron", expr: "nope", tz: "UTC" }, COMMAND, "2026-03-02T09:00:00Z");
    addJob("good", { kind: "every", minutes: 10 }, COMMAND, "2026-03-02T09:50:00Z");
    expect(() => engine.tick()).not.toThrow();
    expect((db.query("SELECT enabled FROM scheduled_jobs WHERE id='bad'").get() as { enabled: number }).enabled).toBe(0);
    expect(statuses("good").length).toBeGreaterThan(0);
  });
});

describe("lost occurrences behind a running job (review finding)", () => {
  test("occurrences lost while the previous run is open are counted as overlap, not stall", () => {
    const { executor } = fakeCommand();
    const engine = createScheduleEngine(db, { executors: { command: executor }, now: () => clock });
    addJob("j", { kind: "cron", expr: "*/10 * * * *", tz: "UTC" }, COMMAND, "2026-01-01T00:10:00.000Z");
    setClock("2026-01-01T00:10:05.000Z"); engine.tick();
    setClock("2026-01-01T00:40:05.000Z"); engine.tick(); // 00:20 and 00:30 lost, 00:40 skipped, run still open
    const missed = runs("j").find(r => r.status === "missed");
    expect([missed?.cause, missed?.missed_count]).toEqual(["overlap", 2]);
  });
});
