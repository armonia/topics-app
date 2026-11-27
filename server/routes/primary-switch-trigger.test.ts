/**
 * @covers MACHINE-07
 *
 * The trigger of a primary switch (track T4) with the REAL scheduled jobs
 * engine and the REAL fence on a DB opened by `initDatabase`: the drain pauses
 * the job starts, a scheduled run still in flight at the end of the wait is
 * parked (cancelled) like a card, and a refusal from the receiver puts the
 * engine back to work. Only the node and the dispatcher are stubbed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, initDatabase } from "../db";
import { setPrimaryFence } from "../lib/primary-fence";
import { fenceInternalWrites, initPrimaryRole } from "../lib/primary-role";
import { createScheduleEngine, type ActionExecutor } from "../schedule/engine";
import { handlePrimarySwitch, type PrimarySwitchTriggerDeps } from "./primary-switch-trigger";
import type { Database } from "bun:sqlite";

const STAMP = "2026-01-01T00:10:00.000Z";
const NODE = { id: "m-node", name: "node", hostname: "node-host", baseUrl: "https://node.example" };
const COMMAND = { kind: "command", argv: ["echo"], stdin: null, cwd: null, env: {}, timeoutSec: 60 };

let root: string;
let previousDataDir: string | undefined;
let db: Database;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "primary-trigger-"));
  previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = join(root, "data");
  db = initDatabase(join(import.meta.dir, "..", ".."), root);
  db.run("INSERT INTO projects (id, name, slug, path, created_at, updated_at) VALUES ('p1', 'P1', 'p1', '/work/p1', ?, ?)", [STAMP, STAMP]);
  mkdirSync(join(root, "state", "nodes"), { recursive: true });
  writeFileSync(join(root, "state", "nodes", `${NODE.id}.token`), "a-node-token-of-enough-length");
});

afterEach(() => {
  setPrimaryFence(null);
  fenceInternalWrites(false);
  closeDatabase();
  if (previousDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previousDataDir;
  // Best effort, like the other initDatabase tests: Windows can keep the SQLite files locked after close.
  try { rmSync(root, { recursive: true, force: true }); } catch { /* temp dir cleanup only */ }
});

describe("primary switch trigger: the scheduled jobs engine", () => {
  test("drain pauses the starts, a run still in flight is parked, the refusal resumes the engine", async () => {
    initPrimaryRole({ db, stateFile: join(root, "primary-state.json"), localMachineId: () => "m-local", log: () => {} });
    const launched: string[] = [];
    const stopped: string[] = [];
    const executor: ActionExecutor = {
      atomic: false,
      start(_job, run) { launched.push(run.occurrenceKey); return { status: "running", processRef: "proc-1" }; },
      stop(_job, run) { stopped.push(run.id); },
    };
    const engine = createScheduleEngine(db, { executors: { command: executor }, now: () => new Date(STAMP) });
    engine.start(() => true);
    db.prepare(`INSERT INTO scheduled_jobs (id, name, project_id, schedule_json, action_json, enabled, next_run_at, created_at, updated_at)
      VALUES ('job-a', 'job-a', 'p1', ?, ?, 1, ?, ?, ?)`).run(JSON.stringify({ kind: "every", minutes: 10 }), JSON.stringify(COMMAND), STAMP, STAMP, STAMP);
    engine.tick();
    const [run] = engine.inFlightRuns();
    expect(run?.jobId).toBe("job-a");

    const calls: string[] = [];
    const cancels: Array<[string, string]> = [];
    const deps: PrimarySwitchTriggerDeps = {
      ctx: {
        db,
        STATE_DIR: join(root, "state"),
        APP_DATA_DIR: join(root, "data"),
        activeStreams: new Map(),
        machineStore: {
          upsertLocal: () => ({ id: "m-local", name: "local", hostname: "local-host" }),
          list: () => [{ id: "m-local", name: "local", hostname: "local-host" }, NODE],
        },
      } as unknown as PrimarySwitchTriggerDeps["ctx"],
      dispatcher: { drain: () => calls.push("dispatcher.drain"), undrain: () => calls.push("dispatcher.undrain"), busyTurns: () => [], nodeRunsOn: () => [], parkNodeRun: async () => null },
      release: () => undefined,
      schedule: {
        pauseStarts: () => { calls.push("schedule.pause"); engine.pauseStarts(); },
        resumeStarts: () => { calls.push("schedule.resume"); engine.resumeStarts(); },
        inFlightRuns: () => engine.inFlightRuns(),
        cancelOpenRuns: (jobId, reason) => { cancels.push([jobId, reason]); return engine.cancelOpenRuns(jobId, reason); },
      },
      abortTurn: async () => undefined,
      // The receiver takes the upload and says an explicit no to the commit: the switch is undone.
      fetch: (async (_url: unknown, init?: RequestInit) => init?.method === "PUT"
        ? new Response("{}", { status: 200 })
        : new Response(JSON.stringify({ code: "not_ready", error: "no" }), { status: 409 })) as unknown as typeof fetch,
    };

    const res = await handlePrimarySwitch(
      new Request("http://localhost/__daemon/primary-switch", { method: "POST", body: JSON.stringify({ machine: NODE.id, drainTimeoutMs: 0 }) }),
      deps,
    );
    const report = await res.json() as { outcome: string; parked: string[] };

    expect(report.outcome).toBe("refused");
    // The in-flight run was parked once, with the engine's own call, and its process stopped.
    expect(cancels).toEqual([["job-a", expect.any(String)]]);
    expect(report.parked).toEqual([`scheduled-run:${run!.runId}`]);
    expect(stopped).toEqual([run!.runId]);
    expect((db.query("SELECT status FROM scheduled_job_runs WHERE id = ?").get(run!.runId) as { status: string }).status).toBe("cancelled");
    // The order: the drain paused the job starts, the undo resumed them (then the dispatcher).
    expect(calls).toEqual(["dispatcher.drain", "schedule.pause", "schedule.resume", "dispatcher.undrain"]);
    expect(engine.inFlightRuns()).toEqual([]);
    expect(launched).toHaveLength(1);
    engine.stop();
  });
});

describe("primary switch trigger: card runs on the destination", () => {
  /** A trigger whose dispatcher reports `onTarget` as the runs riding on the target node, and records the parks. */
  function triggerWith(onTarget: () => Array<{ taskId: string; sessionKey: string }>) {
    initPrimaryRole({ db, stateFile: join(root, "primary-state.json"), localMachineId: () => "m-local", log: () => {} });
    const asked: string[] = [];
    const parkedRuns: Array<[string, string]> = [];
    const releases: string[] = [];
    const deps: PrimarySwitchTriggerDeps = {
      ctx: {
        db,
        STATE_DIR: join(root, "state"),
        APP_DATA_DIR: join(root, "data"),
        activeStreams: new Map(),
        machineStore: {
          upsertLocal: () => ({ id: "m-local", name: "local", hostname: "local-host" }),
          list: () => [{ id: "m-local", name: "local", hostname: "local-host" }, NODE],
        },
      } as unknown as PrimarySwitchTriggerDeps["ctx"],
      dispatcher: {
        drain: () => undefined,
        undrain: () => undefined,
        busyTurns: () => [],
        nodeRunsOn: (machineId) => { asked.push(machineId); return onTarget(); },
        parkNodeRun: async (taskId, note) => { parkedRuns.push([taskId, note]); return true; },
      },
      release: (args) => { releases.push(args.taskId); },
      schedule: { pauseStarts: () => undefined, resumeStarts: () => undefined, inFlightRuns: () => [], cancelOpenRuns: () => 0 },
      abortTurn: async () => undefined,
      fetch: (async (_url: unknown, init?: RequestInit) => init?.method === "PUT"
        ? new Response("{}", { status: 200 })
        : new Response(JSON.stringify({ code: "not_ready", error: "no" }), { status: 409 })) as unknown as typeof fetch,
    };
    const run = async (drainTimeoutMs: number) => {
      const res = await handlePrimarySwitch(
        new Request("http://localhost/__daemon/primary-switch", { method: "POST", body: JSON.stringify({ machine: NODE.id, drainTimeoutMs }) }),
        deps,
      );
      return await res.json() as { outcome: string; parked: string[] };
    };
    return { run, asked, parkedRuns, releases };
  }

  test("a run still riding on the target at the end of the wait is cancelled there and its card requeued, never released as a local turn", async () => {
    const run = { taskId: "card-on-target", sessionKey: `node:${NODE.id}:run-1` };
    const t = triggerWith(() => [run]);
    const report = await t.run(0);
    // The question is asked about the TARGET, and the run it names is parked through the node path.
    expect(t.asked.every((id) => id === NODE.id)).toBe(true);
    expect(t.asked.length).toBeGreaterThan(0);
    expect(report.parked).toEqual([run.taskId]);
    expect(t.parkedRuns).toEqual([["card-on-target", expect.stringContaining("Passaggio")]]);
    expect(t.releases, "the local release path would leave node_run_id behind").toEqual([]);
  });

  test("a run on the target that ends during the wait is waited for, not parked", async () => {
    let calls = 0;
    const run = { taskId: "card-on-target", sessionKey: `node:${NODE.id}:run-1` };
    // Present on the first look (the drain loop), gone on the second (after one poll).
    const t = triggerWith(() => (++calls <= 1 ? [run] : []));
    const report = await t.run(10_000);
    expect(report.parked).toEqual([]);
    expect(t.parkedRuns).toEqual([]);
  });
});
