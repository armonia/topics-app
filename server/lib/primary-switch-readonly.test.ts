/**
 * @covers MACHINE-07
 *
 * The switch fence at the one place every writer goes through (track T4): from
 * the fence on, the live DB handle is read-only, so neither the scheduled jobs
 * engine nor a dispatcher sweep can write into the DB that was handed over,
 * whatever path they take. These tests run the REAL engine and the REAL task
 * service on a DB opened by `initDatabase`, with the fence raised by
 * `setPrimaryFence`: no lambda that only asks the role.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, initDatabase, isFencedWriteError } from "../db";
import { setPrimaryFence } from "./primary-fence";
import { createPrimaryRole, fenceInternalWrites } from "./primary-role";
import type { RetiredState } from "./primary-switch";
import { createScheduleEngine, type ActionExecutor } from "../schedule/engine";
import { createTaskService } from "../services/tasks";
import type { Database } from "bun:sqlite";

const FENCE: RetiredState = { epoch: 2, toMachineId: "m-new", toName: "new", at: "2026-01-01T00:00:00.000Z", phase: "fencing" };
const COMMAND = { kind: "command", argv: ["echo"], stdin: null, cwd: null, env: {}, timeoutSec: 60 };

let root: string;
let previousDataDir: string | undefined;
let db: Database;

const STAMP = "2026-01-01T00:00:00.000Z";
const insertProject = (id: string) => db.run(
  "INSERT INTO projects (id, name, slug, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  [id, id.toUpperCase(), id, `/work/${id}`, STAMP, STAMP],
);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "primary-readonly-"));
  previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = join(root, "data");
  db = initDatabase(join(import.meta.dir, "..", ".."), root);
  insertProject("p1");
});

afterEach(() => {
  setPrimaryFence(null);
  fenceInternalWrites(false);
  closeDatabase();
  if (previousDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previousDataDir;
  // Best effort, like the other initDatabase tests: Windows can keep the SQLite files locked after close.
  try { rmSync(root, { recursive: true, force: true }); } catch { /* temp dir cleanup only */ }
});

/** A command-like executor that stays `running` until the engine is told the run ended. */
function fakeCommand() {
  const launched: string[] = [];
  const stopped: string[] = [];
  const executor: ActionExecutor = {
    atomic: false,
    start(_job, run) { launched.push(run.occurrenceKey); return { status: "running", processRef: `proc-${launched.length}` }; },
    stop(_job, run) { stopped.push(run.id); },
  };
  return { executor, launched, stopped };
}

function addJob(id: string, nextRunAt: string) {
  db.prepare(`INSERT INTO scheduled_jobs (id, name, project_id, schedule_json, action_json, enabled, next_run_at, created_at, updated_at)
    VALUES (?, ?, 'p1', ?, ?, 1, ?, ?, ?)`).run(id, id, JSON.stringify({ kind: "every", minutes: 10 }), JSON.stringify(COMMAND), nextRunAt, nextRunAt, nextRunAt);
}

const dump = () => JSON.stringify({
  runs: db.query("SELECT id, status, finished_at FROM scheduled_job_runs ORDER BY id").all(),
  jobs: db.query("SELECT id, next_run_at FROM scheduled_jobs ORDER BY id").all(),
  tasks: db.query("SELECT id, dispatch_state, updated_at FROM tasks ORDER BY id").all(),
});

/** Runs a writer and keeps what it threw: under the fence the write is refused, never applied. */
function attempt(write: () => unknown): unknown {
  try { write(); return null; } catch (err) { return err; }
}

describe("primary switch fence: the live DB is read-only", () => {
  test("a run that closes after the fence (finishRun, then tick) and a dispatcher sweep change nothing", () => {
    let clock = new Date("2026-01-01T00:10:00.000Z");
    const { executor, launched } = fakeCommand();
    const engine = createScheduleEngine(db, { executors: { command: executor }, now: () => clock });
    addJob("job-a", "2026-01-01T00:10:00.000Z");
    addJob("job-b", "2026-01-01T00:20:00.000Z");
    engine.tick();
    const [run] = engine.inFlightRuns();
    expect(run?.jobId).toBe("job-a");
    const svc = createTaskService(db);
    const card = svc.create({ projectId: "p1", text: "a card the sweep would touch" });
    svc.setDispatchState({ taskId: card.id, state: "queued" });

    setPrimaryFence(FENCE);
    clock = new Date("2026-01-01T00:25:00.000Z");
    const before = dump();

    // The engine path the boot wires: a command ends, `finishRun` closes it and ticks (job-b is due).
    const engineError = attempt(() => engine.finishRun(run!.runId, "ok"));
    // The reconcile sweep of a stale chip: the same service call it makes.
    const sweepError = attempt(() => svc.setDispatchState({ taskId: card.id, state: null }));

    expect(dump()).toBe(before);
    expect(launched).toHaveLength(1);
    expect(isFencedWriteError(engineError)).toBe(true);
    expect(isFencedWriteError(sweepError)).toBe(true);

    // The fence lifted (an undo): the same writes go through again.
    setPrimaryFence(null);
    expect(attempt(() => svc.setDispatchState({ taskId: card.id, state: null }))).toBeNull();
    expect(dump()).not.toBe(before);
  });

  test("the handing-over server adopts the new primary under the fence: the file records it, the read-only DB is skipped", () => {
    const stateFile = join(root, "primary-state.json");
    const role = createPrimaryRole({ db, stateFile, localMachineId: () => "m-old", log: () => {} });
    role.adopt({ primaryMachineId: "m-old", epoch: 1 });
    setPrimaryFence({ ...FENCE, phase: "sent" });
    expect(role.adopt({ primaryMachineId: "m-new", epoch: 2 })).toMatchObject({ primaryMachineId: "m-new", epoch: 2 });
    expect(role.isPrimary()).toBe(false);
    expect(JSON.parse(readFileSync(stateFile, "utf-8"))).toMatchObject({ primaryMachineId: "m-new", epoch: 2 });
    setPrimaryFence(null);
    expect((db.query("SELECT epoch FROM primary_state WHERE id = 1").get() as { epoch: number }).epoch).toBe(1);
  });

  test("a set-aside server runs on a fresh DB: the handle stays writable there", () => {
    setPrimaryFence({ ...FENCE, phase: "set-aside" });
    expect(attempt(() => insertProject("p2"))).toBeNull();
  });

  test("a set-aside server opens its service DB under another name: the live path stays empty", () => {
    closeDatabase();
    rmSync(join(root, "data"), { recursive: true, force: true });
    setPrimaryFence({ ...FENCE, phase: "set-aside" });
    initDatabase(join(import.meta.dir, "..", ".."), root);
    expect(existsSync(join(root, "data", "topics.db"))).toBe(false);
    expect(existsSync(join(root, "data", "topics.retired.db"))).toBe(true);
  });

  test("a scheduled run in flight at the drain is parked once and never starts again", () => {
    let clock = new Date("2026-01-01T00:10:00.000Z");
    const { executor, launched, stopped } = fakeCommand();
    const engine = createScheduleEngine(db, { executors: { command: executor }, now: () => clock });
    engine.start(() => true);
    addJob("job-a", "2026-01-01T00:10:00.000Z");
    engine.tick();
    expect(engine.inFlightRuns()).toHaveLength(1);

    // What the switch does with it (routes/primary-switch-trigger.ts): drain pauses the starts, park cancels the run.
    engine.pauseStarts();
    const [run] = engine.inFlightRuns();
    expect(engine.cancelOpenRuns(run!.jobId, "primary switch")).toBe(1);
    setPrimaryFence(FENCE);

    expect(stopped).toEqual([run!.runId]);
    expect(engine.inFlightRuns()).toEqual([]);
    const row = db.query("SELECT status FROM scheduled_job_runs WHERE id = ?").get(run!.runId) as { status: string };
    expect(row.status).toBe("cancelled");

    // On the new primary the copy carries the run closed: a tick there does not start it a second time.
    setPrimaryFence(null);
    engine.resumeStarts();
    clock = new Date("2026-01-01T00:11:00.000Z");
    engine.tick();
    expect(launched).toHaveLength(1);
    engine.stop();
  });

  test("tick asks the role itself, not only the timer", () => {
    const clock = new Date("2026-01-01T00:10:00.000Z");
    const { executor, launched } = fakeCommand();
    const engine = createScheduleEngine(db, { executors: { command: executor }, now: () => clock });
    let primary = false;
    engine.start(() => primary);
    addJob("job-a", "2026-01-01T00:10:00.000Z");
    expect(engine.tick()).toEqual({ created: [], skipped: [], started: [] });
    expect(launched).toHaveLength(0);
    primary = true;
    engine.tick();
    expect(launched).toHaveLength(1);
    engine.stop();
  });
});
