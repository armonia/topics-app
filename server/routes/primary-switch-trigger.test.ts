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
import { Database } from "bun:sqlite";
import { DB_NAME } from "../lib/primary-switch";
import { flush, dispatch, harness, MACHINE, TASK } from "../services/task-dispatcher-remote-node-test-support";

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
      dispatcher: { drain: () => calls.push("dispatcher.drain"), undrain: () => calls.push("dispatcher.undrain"), busyTurns: () => [], nodeRunsOn: () => [], nodeLaunchesInFlight: () => [], parkNodeRun: async () => null },
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
        nodeLaunchesInFlight: () => [],
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

describe("primary switch trigger: a card launch still in the air toward the destination", () => {
  const TARGET = { id: MACHINE, name: "node", hostname: "node-host", baseUrl: "https://node.example" };

  /** The REAL dispatcher of the remote lane behind the trigger, its `createRun` held by the test. */
  function triggerOverLaunch() {
    writeFileSync(join(root, "state", "nodes", `${TARGET.id}.token`), "a-node-token-of-enough-length");
    initPrimaryRole({ db, stateFile: join(root, "primary-state.json"), localMachineId: () => "m-local", log: () => {} });
    let answer!: (v: { runId: string }) => void;
    const h = harness({ createRun: () => new Promise((r) => { answer = r; }) });
    h.seed();
    const deps: PrimarySwitchTriggerDeps = {
      ctx: {
        db,
        STATE_DIR: join(root, "state"),
        APP_DATA_DIR: join(root, "data"),
        activeStreams: new Map(),
        machineStore: {
          upsertLocal: () => ({ id: "m-local", name: "local", hostname: "local-host" }),
          list: () => [{ id: "m-local", name: "local", hostname: "local-host" }, TARGET],
        },
      } as unknown as PrimarySwitchTriggerDeps["ctx"],
      dispatcher: h.dispatcher,
      release: () => undefined,
      schedule: { pauseStarts: () => undefined, resumeStarts: () => undefined, inFlightRuns: () => [], cancelOpenRuns: () => 0 },
      abortTurn: async () => undefined,
      fetch: (async (_url: unknown, init?: RequestInit) => init?.method === "PUT"
        ? new Response("{}", { status: 200 })
        : new Response(JSON.stringify({ code: "not_ready", error: "no" }), { status: 409 })) as unknown as typeof fetch,
    };
    const run = async (drainTimeoutMs: number) => {
      const res = await handlePrimarySwitch(
        new Request("http://localhost/__daemon/primary-switch", { method: "POST", body: JSON.stringify({ machine: TARGET.id, drainTimeoutMs }) }),
        deps,
      );
      return await res.json() as { outcome: string; parked: string[] };
    };
    return { h, run, answer: (runId: string) => answer({ runId }) };
  }

  test("a createRun nobody answered when the wait expires is parked: run cancelled when it is born, card back in the queue", async () => {
    const t = triggerOverLaunch();
    await dispatch(t.h);
    expect(t.h.calls).toContain("create");
    expect(t.h.task().status).toBe("in_progress");

    const report = await t.run(0);
    // The launch is the work the switch found, and it went through the node path.
    expect(report.parked).toEqual([TASK]);
    expect(t.h.task().status).toBe("todo");
    const stored = () => (t.h.db.query("SELECT node_run_id FROM tasks WHERE id = ?").get(TASK) as { node_run_id: string | null }).node_run_id;
    expect(stored(), "the card is not tied to a run the node never named").toBeNull();

    t.answer("run-late");
    await flush();
    expect(t.h.calls).toContain("cancel:run-late");
    expect(t.h.task().status).toBe("todo");
    expect(stored()).toBeNull();
  });

  test("the switch waits for a launch that is still in the air and parks nothing", async () => {
    const t = triggerOverLaunch();
    await dispatch(t.h);
    let settled = false;
    const switching = t.run(60_000).then((r) => { settled = true; return r; });
    await new Promise((r) => setTimeout(r, 100));
    expect(settled, "the switch is still waiting").toBe(false);
    expect(t.h.task().status, "and the launch was left alone").toBe("in_progress");

    // The node names the run, then the run leaves (here: parked by hand, as the board does when it
    // gives up on a run): the next look of the drain finds nothing left, and the switch itself parked nothing.
    t.answer("run-1");
    await flush();
    expect(t.h.dispatcher.nodeRunsOn(MACHINE), "the named run still counts").toEqual([{ taskId: TASK, sessionKey: `node:${MACHINE}:run-1` }]);
    await t.h.dispatcher.parkNodeRun(TASK, "run gone");
    const report = await switching;
    expect(report.parked).toEqual([]);
  }, 15_000);
});

describe("primary switch trigger: a card launch still in the air toward a THIRD machine", () => {
  // The switch goes to TARGET; the card is launching on MACHINE, a node that is not the destination.
  const TARGET = { id: "m-destination", name: "destination", hostname: "destination-host", baseUrl: "https://destination.example" };
  const THIRD = { id: MACHINE, name: "node", hostname: "node-host", baseUrl: "https://node.example" };

  test("is parked before the snapshot, and the DB the new primary receives has the card back in the queue", async () => {
    writeFileSync(join(root, "state", "nodes", `${TARGET.id}.token`), "a-node-token-of-enough-length");
    initPrimaryRole({ db, stateFile: join(root, "primary-state.json"), localMachineId: () => "m-local", log: () => {} });
    let answer!: (v: { runId: string }) => void;
    const h = harness({ createRun: () => new Promise((r) => { answer = r; }) });
    h.seed();
    // The bench DB holds the cards only; the switch reads the rest of the schema (counts, transcripts), copied from the real one.
    const have = new Set((h.db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name));
    for (const t of db.query("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string; sql: string }>) {
      if (!have.has(t.name)) { h.db.run(t.sql); continue; }
      const cols = new Set((h.db.query(`PRAGMA table_info(${t.name})`).all() as Array<{ name: string }>).map((c) => c.name));
      for (const c of db.query(`PRAGMA table_info(${t.name})`).all() as Array<{ name: string; type: string }>) {
        if (!cols.has(c.name)) h.db.run(`ALTER TABLE ${t.name} ADD COLUMN ${c.name} ${c.type}`);
      }
    }
    // What the destination receives, chunk by chunk: the bytes of the DB snapshot.
    const shipped = new Map<string, Uint8Array[]>();
    const deps: PrimarySwitchTriggerDeps = {
      ctx: {
        // The snapshot is of the DB the dispatcher writes: the card must be in it.
        db: h.db,
        STATE_DIR: join(root, "state"),
        APP_DATA_DIR: join(root, "data"),
        activeStreams: new Map(),
        machineStore: {
          upsertLocal: () => ({ id: "m-local", name: "local", hostname: "local-host" }),
          list: () => [{ id: "m-local", name: "local", hostname: "local-host" }, TARGET, THIRD],
        },
      } as unknown as PrimarySwitchTriggerDeps["ctx"],
      dispatcher: h.dispatcher,
      release: () => undefined,
      schedule: { pauseStarts: () => undefined, resumeStarts: () => undefined, inFlightRuns: () => [], cancelOpenRuns: () => 0 },
      abortTurn: async () => undefined,
      fetch: (async (url: unknown, init?: RequestInit) => {
        if (init?.method !== "PUT") return new Response(JSON.stringify({ code: "not_ready", error: "no" }), { status: 409 });
        const name = new URL(String(url)).searchParams.get("name")!;
        shipped.set(name, [...(shipped.get(name) ?? []), new Uint8Array(init.body as Uint8Array)]);
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    };
    await dispatch(h);
    expect(h.calls).toContain("create");
    expect(h.dispatcher.nodeRunsOn(TARGET.id), "nothing runs on the destination").toEqual([]);

    const res = await handlePrimarySwitch(
      new Request("http://localhost/__daemon/primary-switch", { method: "POST", body: JSON.stringify({ machine: TARGET.id, drainTimeoutMs: 0 }) }),
      deps,
    );
    const report = await res.json() as { parked: string[] };
    expect(report.parked).toEqual([TASK]);

    // The card as the new primary opens it: back in the queue, no run id, so its dispatcher starts it again.
    const bytes = Buffer.concat(shipped.get(DB_NAME) ?? []);
    expect(bytes.byteLength, "the snapshot was shipped").toBeGreaterThan(0);
    const copy = join(root, "received.db");
    writeFileSync(copy, bytes);
    const received = new Database(copy, { readonly: true });
    try {
      const card = received.query("SELECT status, node_run_id FROM tasks WHERE id = ?").get(TASK) as { status: string; node_run_id: string | null };
      expect(card).toEqual({ status: "todo", node_run_id: null });
    } finally {
      received.close();
    }

    // The third node answers late: the run it created has no owner and is cancelled there.
    answer({ runId: "run-late" });
    await flush();
    expect(h.calls).toContain("cancel:run-late");
    expect(h.task().status).toBe("todo");
  });
});
