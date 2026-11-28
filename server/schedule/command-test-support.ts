/** Shared setup of the command tests: a database with the three migrations, an engine on a fake clock, a fake runner. */
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createCommandAction, type CommandRunner } from "./command-action";
import { createScheduleEngine } from "./engine";
import type { CommandLife } from "./command-life";
import { freshDb } from "../services/tasks-test-db";
import type { RunRow } from "./store";

const MIGRATIONS = join(import.meta.dir, "../db/migrations");

export function migratedDb(): Database {
  const db = freshDb();
  for (const file of ["20261014225051-scheduled-cards.sql", "20261121105631-scheduled-jobs.sql", "20261121160000-scheduled-job-command-output.sql", "20261126180000-scheduled-delivery-guards.sql"]) db.run(readFileSync(join(MIGRATIONS, file), "utf8"));
  return db;
}

export interface FakeProcess { life: CommandLife; exitCode: number | null; timedOut: boolean; stdout: string; stderr: string; stopped: boolean }

/** A runner that spawns nothing: the test says how each process is doing. */
export function fakeRunner() {
  const processes = new Map<string, FakeProcess>();
  const started: Array<{ processId: string; spec: Parameters<CommandRunner["start"]>[0] }> = [];
  const log: string[] = [];
  const runner: CommandRunner & { onStop?: (processId: string) => void } = {
    start(spec) {
      const processId = `proc-${started.length + 1}`;
      started.push({ processId, spec });
      processes.set(processId, { life: "alive", exitCode: null, timedOut: false, stdout: "", stderr: "", stopped: false });
      return { processId };
    },
    life: (processId) => processes.get(processId)?.life ?? "dead",
    report: (processId) => {
      const proc = processes.get(processId);
      return proc && (proc.exitCode !== null || proc.timedOut) ? { exitCode: proc.exitCode, timedOut: proc.timedOut } : null;
    },
    stop(processId) {
      log.push(`stop:${processId}`);
      runner.onStop?.(processId);
      const proc = processes.get(processId);
      if (proc) { proc.stopped = true; proc.life = "dead"; }
    },
    tails: (processId) => ({ stdout: processes.get(processId)?.stdout ?? "", stderr: processes.get(processId)?.stderr ?? "" }),
    jobGroups: () => [...processes.entries()].filter(([, proc]) => proc.life !== "dead").map(([processId]) => ({ processId, jobId: "?" })),
  };
  return { runner, processes, started, log };
}

export function buildEngine(db: Database, runner: CommandRunner, clock: { now: Date }) {
  const door = { closeIfOpen: (...args: Parameters<ReturnType<typeof createScheduleEngine>["closeIfOpen"]>) => engine.closeIfOpen(...args) };
  const action = createCommandAction(db, door, { runner, projectPath: (projectId) => projectId ? "/work/project" : null, now: () => clock.now });
  const engine = createScheduleEngine(db, { executors: { command: action.executor }, now: () => clock.now });
  return { engine, action };
}

export function addCommandJob(db: Database, clock: { now: Date }, id: string, patch: { schedule?: unknown; action?: Record<string, unknown>; policy?: unknown; nextRunAt?: string } = {}) {
  const action = { kind: "command", argv: ["echo", "hi"], stdin: null, cwd: "/work/dir", env: {}, timeoutSec: 60, ...patch.action };
  db.prepare(`INSERT INTO scheduled_jobs (id, name, project_id, schedule_json, action_json, policy_json, enabled, next_run_at, created_at, updated_at)
    VALUES (?, ?, NULL, ?, ?, ?, 1, ?, ?, ?)`)
    .run(id, id, JSON.stringify(patch.schedule ?? { kind: "every", minutes: 10 }), JSON.stringify(action), JSON.stringify(patch.policy ?? {}),
      patch.nextRunAt ?? clock.now.toISOString(), clock.now.toISOString(), clock.now.toISOString());
}

export const runsOf = (db: Database, jobId: string) => db.query("SELECT * FROM scheduled_job_runs WHERE job_id = ? ORDER BY created_at, occurrence_key").all(jobId) as RunRow[];
