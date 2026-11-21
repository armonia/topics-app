/**
 * The `command` action (rules R11 to R14 of change lavori-programmati-in-topics).
 *
 * The engine decides WHEN; this module launches the command through a
 * `CommandRunner` (the registry of processes in production, a stub in tests),
 * and keeps SQLite true to the thing that really runs:
 *  - an end reported by the registry closes the run once;
 *  - every tick `sweep` re-reads the open runs from the process itself, so a
 *    command that ended while the server was down, or whose row `scripts.json`
 *    lost, still closes, and one lost without a code is `interrupted` and
 *    started again ONCE (R12);
 *  - the time limit is applied here too, with `timeout` written BEFORE the stop (R13);
 *  - when it closes, the tail of stdout and stderr goes to SQLite (R14).
 */
import type { Database } from "bun:sqlite";
import type { ActionExecutor } from "./engine";
import { parseJob, parseRun, type RunRow, type ScheduledJob, type ScheduledJobRow, type ScheduledRun } from "./store";
import { normalizeCommandAction } from "./command-spec";
import type { CommandLife } from "./command-life";

/** What is kept of each stream when a run closes. */
export const OUTPUT_TAIL_BYTES = 64 * 1024;

export interface CommandRunSpec {
  jobId: string; runId: string; argv: string[]; cwd: string; stdin: string | null;
  env: Record<string, string>; timeoutSec: number;
}

export interface CommandReport {
  /** The code the wrapper wrote; null when none exists. */
  exitCode: number | null;
  /** The wrapper's own time limit fired. */
  timedOut: boolean;
}

export interface CommandRunner {
  start(spec: CommandRunSpec): { processId: string };
  /** `alive`, `dead` (provably gone) or `unknown` (the probe did not answer: never started again). */
  life(processId: string): CommandLife;
  /** The end the process left behind (its exit file), or null while there is none. */
  report(processId: string): CommandReport | null;
  /** Stops the whole group. */
  stop(processId: string): void;
  tails(processId: string): { stdout: string; stderr: string };
  /** The live groups that belong to scheduled jobs, whether or not the registry knows their row. */
  jobGroups(): { processId: string; jobId: string }[];
}

export interface CommandActionOptions {
  runner: CommandRunner;
  /** Where a command runs when the job names no directory: the directory of its project. */
  projectPath: (projectId: string | null) => string | null;
  /** Called when a run closes, so a job waiting on it can restart right away (R9). */
  onClosed?: () => void;
  now?: () => Date;
}

type FinalStatus = "ok" | "error" | "timeout" | "cancelled" | "interrupted";

export interface CommandEngineDoor {
  closeIfOpen(runId: string, status: FinalStatus, reason: string | null, extra?: { exitCode?: number | null; stdoutTail?: string; stderrTail?: string }): boolean;
}

export function createCommandAction(db: Database, door: CommandEngineDoor, options: CommandActionOptions) {
  const { runner } = options;
  const now = options.now ?? (() => new Date());

  const job = (id: string) => {
    const row = db.query("SELECT * FROM scheduled_jobs WHERE id = ?").get(id) as ScheduledJobRow | null;
    return row ? parseJob(row) : null;
  };
  const runBy = (id: string) => {
    const row = db.query("SELECT * FROM scheduled_job_runs WHERE id = ?").get(id) as RunRow | null;
    return row ? parseRun(row) : null;
  };
  const openCommandRuns = () => (db.query(`SELECT r.* FROM scheduled_job_runs r JOIN scheduled_jobs j ON j.id = r.job_id
    WHERE r.status = 'running' AND json_extract(j.action_json, '$.kind') = 'command'`).all() as RunRow[]).map(parseRun);

  function tailsOf(processId: string) {
    const { stdout, stderr } = runner.tails(processId);
    return { stdoutTail: stdout.slice(-OUTPUT_TAIL_BYTES), stderrTail: stderr.slice(-OUTPUT_TAIL_BYTES) };
  }

  /** The end of a command, read once and closed once: the loser of a race changes no row. */
  function closeFromReport(runId: string, processId: string, report: CommandReport) {
    const status: FinalStatus = report.timedOut ? "timeout" : report.exitCode === 0 ? "ok" : "error";
    const reason = report.timedOut ? "The command went over its time limit."
      : report.exitCode === null ? "The command ended without writing an exit code."
      : report.exitCode === 0 ? null : `Exit code ${report.exitCode}.`;
    if (door.closeIfOpen(runId, status, reason, { exitCode: report.exitCode, ...tailsOf(processId) })) options.onClosed?.();
  }

  /** R12: provably dead without a code. `interrupted` is not an error, and the occurrence is started again once. */
  function interrupt(run: ScheduledRun, current: ScheduledJob | null) {
    if (!door.closeIfOpen(run.id, "interrupted", "The process was lost before it wrote an exit code.", tailsOf(run.processRef!))) return;
    // The counter is the row itself: its key is unique, so the retry exists once even if two engines read this together.
    if (current && !current.deletedAt && current.policy.repeatable !== false && !run.occurrenceKey.includes("#r")) {
      db.prepare(`INSERT INTO scheduled_job_runs (id, job_id, occurrence_key, scheduled_for, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)
        ON CONFLICT(job_id, occurrence_key) DO NOTHING`).run(crypto.randomUUID(), run.jobId, `${run.occurrenceKey}#r1`, run.scheduledFor.toISOString(), now().toISOString());
    }
    options.onClosed?.();
  }

  function applyTimeLimit(run: ScheduledRun, current: ScheduledJob | null, instant: Date) {
    const action = current?.action;
    if (!run.startedAt || action?.kind !== "command") return;
    if (instant.getTime() - run.startedAt.getTime() <= action.timeoutSec * 1000) return;
    // `timeout` goes into SQLite first: whatever the stop does next, the run is already judged.
    if (door.closeIfOpen(run.id, "timeout", "The command went over its time limit.", tailsOf(run.processRef!))) {
      runner.stop(run.processRef!);
      options.onClosed?.();
    }
  }

  const executor: ActionExecutor = {
    atomic: false,
    start(current, run) {
      const action = normalizeCommandAction(current.action);
      const cwd = action.cwd ?? options.projectPath(current.projectId);
      if (!cwd) throw new Error("The command has no directory: name one or give the job a project.");
      const { processId } = runner.start({ jobId: current.id, runId: run.id, argv: action.argv, cwd, stdin: action.stdin, env: action.env, timeoutSec: action.timeoutSec });
      return { status: "running", processRef: processId };
    },
    stop(_current, run) {
      if (run.processRef) runner.stop(run.processRef);
    },
    sweep(instant) {
      for (const run of openCommandRuns()) {
        if (!run.processRef) continue;
        const report = runner.report(run.processRef);
        if (report) { closeFromReport(run.id, run.processRef, report); continue; }
        if (runner.life(run.processRef) === "dead") {
          // The code may have been written between the first read and the probe: a command that ended well is not lost.
          const late = runner.report(run.processRef);
          if (late) closeFromReport(run.id, run.processRef, late); else interrupt(run, job(run.jobId));
          continue;
        }
        // Alive, or the probe did not answer: it is left running, and never started a second time.
        applyTimeLimit(run, job(run.jobId), instant);
      }
      // A group of a scheduled job that no open run owns must not go on (run cancelled, `scripts.json` lost).
      const owned = new Set(openCommandRuns().map(run => run.processRef));
      for (const group of runner.jobGroups()) if (!owned.has(group.processId)) runner.stop(group.processId);
    },
  };

  return {
    executor,
    /** The registry reported the end of a process: close its run. */
    ended(end: { processId: string; runId: string; exitCode: number | null; stopped: boolean; timedOut: boolean }) {
      const run = runBy(end.runId);
      if (!run) return;
      // A Stop of Topics: the reason (`cancelled`, `timeout`) was written before it, so the closing finds the row closed.
      if (end.stopped && !end.timedOut) {
        if (door.closeIfOpen(run.id, "cancelled", "Stopped.", tailsOf(end.processId))) options.onClosed?.();
        return;
      }
      // Dead with no code and no Stop of ours (killed, lost with the machine): interrupted, not an error (R12).
      if (end.exitCode === null && !end.timedOut) { interrupt({ ...run, processRef: end.processId }, job(run.jobId)); return; }
      closeFromReport(run.id, end.processId, { exitCode: end.exitCode, timedOut: end.timedOut });
    },
  };
}
