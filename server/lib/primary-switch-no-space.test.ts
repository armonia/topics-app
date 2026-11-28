/**
 * @covers MACHINE-07
 *
 * The receiver answers the commit with `no_space`: the sender stays the
 * primary as if nothing happened. The REAL `runPrimarySwitch` on a DB opened by
 * `initDatabase`, the REAL fence (`setPrimaryFence`), the REAL schedule engine
 * and the receiver's own `commitIncoming` with a disk that is full.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, initDatabase } from "../db";
import { retiredRefusal, setPrimaryFence } from "./primary-fence";
import { createPrimaryRole, fenceInternalWrites, isThisServerPrimary } from "./primary-role";
import { commitIncoming, DB_NAME, OUTGOING_DIR, RETIRED_FILE, writeIncomingChunk } from "./primary-switch";
import { createScheduleEngine, type ActionExecutor } from "../schedule/engine";
import { runPrimarySwitch } from "../services/primary-switch-run";

const STAMP = "2026-01-01T00:00:00.000Z";
let root: string;
let receiverState: string;
let previousDataDir: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "primary-nospace-"));
  receiverState = join(root, "receiver-state");
  mkdirSync(receiverState, { recursive: true });
  previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = join(root, "data");
});

afterEach(() => {
  setPrimaryFence(null);
  fenceInternalWrites(false);
  closeDatabase();
  if (previousDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previousDataDir;
  try { rmSync(root, { recursive: true, force: true }); } catch { /* temp dir cleanup only */ }
});

describe("a commit refused with no_space", () => {
  test("leaves the sender the primary: fence down, DB writable, no retired file, drain undone, the engine runs again", async () => {
    const db = initDatabase(join(import.meta.dir, "..", ".."), root);
    db.run("INSERT INTO projects (id, name, slug, path, created_at, updated_at) VALUES ('p1', 'P1', 'p1', '/work/p1', ?, ?)", [STAMP, STAMP]);
    const role = createPrimaryRole({ db, stateFile: join(root, "primary-state.json"), localMachineId: () => "m-old", log: () => {} });
    role.adopt({ primaryMachineId: "m-old", epoch: 1 });

    const launched: string[] = [];
    const executor: ActionExecutor = {
      atomic: false,
      start(_job, run) { launched.push(run.occurrenceKey); return { status: "running", processRef: "proc" }; },
      stop() {},
    };
    let clock = new Date("2026-01-01T00:10:00.000Z");
    const engine = createScheduleEngine(db, { executors: { command: executor }, now: () => clock });
    db.prepare(`INSERT INTO scheduled_jobs (id, name, project_id, schedule_json, action_json, enabled, next_run_at, created_at, updated_at)
      VALUES ('job', 'job', 'p1', ?, ?, 1, ?, ?, ?)`).run(
      JSON.stringify({ kind: "every", minutes: 10 }),
      JSON.stringify({ kind: "command", argv: ["echo"], stdin: null, cwd: null, env: {}, timeoutSec: 60 }),
      "2026-01-01T00:20:00.000Z", STAMP, STAMP,
    );

    let drained = 0;
    let undrained = 0;
    let restarts = 0;
    const report = await runPrimarySwitch({
      db, stateDir: root, secretsDir: join(root, ".topics-secrets"), appDataDir: root, projectsDir: join(root, "claude-projects"),
      role, localMachineId: "m-old", target: { id: "m-new", hostname: "new-host", name: "server" },
      drain: () => { drained++; }, undrain: () => { undrained++; }, stillWorking: () => [], park: async () => {},
      setFence: setPrimaryFence,
      upload: async (name, offset, bytes) => { writeIncomingChunk(receiverState, name, offset, bytes); },
      commit: async (manifest) => {
        // The receiver's own check, on a disk with no room.
        const v = await commitIncoming(receiverState, manifest, { hostname: "new-host", epoch: 0, freeBytes: () => 0 });
        return v.ok ? { kind: "accepted", counts: v.counts } : { kind: "refused", code: v.code, error: v.error };
      },
      // Never asked: the refusal comes at the commit.
      confirm: async () => ({ kind: "waiting" }), abandon: async () => false,
      restartSelf: () => { restarts++; },
      sleep: async () => {}, pollMs: 0, log: () => {},
    });

    expect(report).toMatchObject({ ok: false, outcome: "refused", step: "commit" });
    expect(report.error).toContain("no_space");
    // Fence down: nothing refuses a request, the live handle takes writes, internal writers run.
    expect(retiredRefusal("/api/tasks", "POST")).toBeNull();
    expect(() => db.run("INSERT INTO topics (id, name, slug, session_key, created_at, updated_at) VALUES ('c1', 'c', 'c', 'k', ?, ?)", [STAMP, STAMP])).not.toThrow();
    expect(isThisServerPrimary()).toBe(true);
    // Still the primary at the same epoch, nothing on disk says otherwise, no restart.
    expect(role.isPrimary()).toBe(true);
    expect(role.epoch()).toBe(1);
    expect(existsSync(join(root, RETIRED_FILE))).toBe(false);
    expect(existsSync(join(root, OUTGOING_DIR, DB_NAME))).toBe(false);
    expect(restarts).toBe(0);
    // The drain is undone and the schedule engine launches the job that comes due.
    expect([drained, undrained]).toEqual([1, 1]);
    clock = new Date("2026-01-01T00:25:00.000Z");
    engine.tick();
    expect(launched).toHaveLength(1);
  });
});
