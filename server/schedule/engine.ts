/**
 * The scheduled-jobs engine (rules R3 to R10 of change lavori-programmati-in-topics).
 *
 * A tick takes every enabled job whose `next_run_at` has passed and turns the
 * occurrence into ONE row of `scheduled_job_runs` with a state. The occurrence
 * key is the UTC instant, the insert is `ON CONFLICT DO NOTHING` and
 * `next_run_at` always moves forward, so a restart, a second tick or a second
 * server on the same file cannot start the same occurrence twice. The step
 * `pending` to `starting` is a conditional UPDATE: whoever changes the row owns
 * the launch.
 */
import type { Database } from "bun:sqlite";
import { isRepeatedWallTime, nextOccurrence, type JobSchedule } from "../../shared/schedule";
import { parseJob, parseRun, type ScheduledJobRow, type RunRow, type ScheduledJob, type ScheduledRun, type RunStatus, type MissedCause, type JobAction } from "./store";

export const TICK_INTERVAL_MS = 15_000;
/** A job whose action never reported a process or a turn this long after `starting` did not start. */
export const STARTING_GRACE_MS = 60_000;
const COMMAND_WINDOW_MS = 6 * 3_600_000;
const AT_WINDOW_MS = 24 * 3_600_000;
const DEFAULT_MAX_CONCURRENT = 4;
/** Longest backlog the engine walks to count lost occurrences. */
const MAX_COUNTED_OCCURRENCES = 1_000;
/** The history of runs is kept this long (R14). */
export const HISTORY_DAYS = 30;
const PRUNE_EVERY_MS = 3_600_000;

export interface StartResult {
  /** `ok` = the action is already over; `running` = the engine waits for `finishRun`. */
  status: "ok" | "running";
  taskId?: string;
  processRef?: string;
}

export interface ActionExecutor {
  /** True when the action must happen inside the same transaction as the run (cards). */
  atomic: boolean;
  /** True when a previous run of the job is still open, judged from the real thing (R6). */
  isBusy?(job: ScheduledJob): boolean;
  start(job: ScheduledJob, run: ScheduledRun, now: Date): StartResult;
  /** Stops what the run started. The engine has already written the run's final state (R13, R25). */
  stop?(job: ScheduledJob, run: ScheduledRun): void;
  /** Called at every tick, before the occurrences are taken: reconciles open runs with the real thing and applies limits (R12, R13). */
  sweep?(now: Date): void;
}

export type Executors = Partial<Record<JobAction["kind"], ActionExecutor>>;

export interface TickResult { created: string[]; skipped: string[]; started: string[] }

export interface EngineOptions {
  executors: Executors;
  now?: () => Date;
  /** Cap on command and agent runs open at once (R10). */
  maxConcurrent?: () => number;
  /** Called at the end of every tick: delivery of finished runs and failure alerts hang here (R22 to R24). */
  onTick?: (instant: Date) => void;
}

export function createScheduleEngine(db: Database, options: EngineOptions) {
  const now = options.now ?? (() => new Date());
  const maxConcurrent = options.maxConcurrent ?? (() => DEFAULT_MAX_CONCURRENT);
  let startsPaused = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  /** Only the primary decides; `start` wires the real question, until then every tick may run (tests, boot). */
  let active: () => boolean = () => true;
  let lastPruneAt = 0;

  const readJob = (id: string) => {
    const row = db.query("SELECT * FROM scheduled_jobs WHERE id = ?").get(id) as ScheduledJobRow | null;
    return row ? parseJob(row) : null;
  };

  function lastTickAt(): Date | null {
    const row = db.query("SELECT last_tick_at FROM scheduled_engine_state WHERE id = 1").get() as { last_tick_at: string | null } | null;
    return row?.last_tick_at ? new Date(row.last_tick_at) : null;
  }

  function writeHeartbeat(at: Date) {
    db.prepare("INSERT INTO scheduled_engine_state (id, last_tick_at) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET last_tick_at = excluded.last_tick_at").run(at.toISOString());
  }

  function insertRun(job: ScheduledJob, key: string, scheduledFor: Date, status: RunStatus, extra: { cause?: MissedCause | "overlap" | null; reason?: string | null; missed?: number }, at: Date): ScheduledRun | null {
    const id = crypto.randomUUID();
    const finished = status === "pending" ? null : at.toISOString();
    const changed = db.prepare(`INSERT INTO scheduled_job_runs (id, job_id, occurrence_key, scheduled_for, status, cause, reason, missed_count, created_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(job_id, occurrence_key) DO NOTHING`)
      .run(id, job.id, key, scheduledFor.toISOString(), status, extra.cause ?? null, extra.reason ?? null, extra.missed ?? 0, at.toISOString(), finished).changes;
    if (changed !== 1) return null;
    return parseRun(db.query("SELECT * FROM scheduled_job_runs WHERE id = ?").get(id) as RunRow);
  }

  function awaitingOwner(jobId: string): boolean {
    return (db.query("SELECT awaiting_owner FROM scheduled_jobs WHERE id = ?").get(jobId) as { awaiting_owner: number } | null)?.awaiting_owner === 1;
  }

  /** The runs of this job that are still open. */
  function hasOpenRun(jobId: string): boolean {
    return db.query("SELECT 1 FROM scheduled_job_runs WHERE job_id = ? AND status IN ('pending','starting','running') LIMIT 1").get(jobId) !== null;
  }

  function finish(runId: string, status: RunStatus, at: Date, reason?: string | null) {
    db.prepare("UPDATE scheduled_job_runs SET status = ?, finished_at = ?, reason = COALESCE(?, reason) WHERE id = ?")
      .run(status, at.toISOString(), reason ?? null, runId);
  }

  /** pending to starting to the action. Returns the task id a card action created. */
  function launch(run: ScheduledRun, at: Date): StartResult | null {
    // The one place two engines on the same file are told apart: only the one that changes the row launches.
    const claimed = db.prepare("UPDATE scheduled_job_runs SET status = 'starting', started_at = ? WHERE id = ? AND status = 'pending'").run(at.toISOString(), run.id).changes;
    if (claimed !== 1) return null;
    const job = readJob(run.jobId);
    const executor = job ? options.executors[job.action.kind] : undefined;
    if (job && (job.deletedAt || (!job.enabled && job.schedule.kind !== "at"))) {
      finish(run.id, "cancelled", at, "The job was turned off or deleted before the run started.");
      return null;
    }
    // R26: a job an agent made waits for a person; no door, a manual run included, starts it before that.
    if (job && awaitingOwner(job.id)) {
      finish(run.id, "cancelled", at, "The job waits for the owner to turn it on.");
      return null;
    }
    if (!job || !executor) {
      finish(run.id, "failed_to_start", at, job ? `No executor for action ${job.action.kind}.` : "The job is gone.");
      return null;
    }
    try {
      const result = executor.start(job, { ...run, status: "starting" }, at);
      if (result.status === "ok") {
        db.prepare("UPDATE scheduled_job_runs SET status = 'ok', finished_at = ?, task_id = ?, process_ref = ? WHERE id = ?")
          .run(at.toISOString(), result.taskId ?? null, result.processRef ?? null, run.id);
      } else {
        db.prepare("UPDATE scheduled_job_runs SET status = 'running', task_id = ?, process_ref = ? WHERE id = ?")
          .run(result.taskId ?? null, result.processRef ?? null, run.id);
      }
      return result;
    } catch (error) {
      finish(run.id, "failed_to_start", at, error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  function windowMs(job: ScheduledJob): number | null {
    if (job.policy.windowMs !== undefined) return job.policy.windowMs;
    if (job.action.kind === "card") return null;
    return job.schedule.kind === "at" ? AT_WINDOW_MS : COMMAND_WINDOW_MS;
  }

  /** Every occurrence from `first` up to `instant`, oldest first, with the repeated wall times already dropped. */
  function dueOccurrences(schedule: JobSchedule, first: Date, instant: Date): { list: Date[]; truncated: boolean } {
    if (schedule.kind === "at") return { list: [first], truncated: false };
    const list: Date[] = [];
    if (schedule.kind === "every") {
      const step = schedule.minutes * 60_000;
      const count = Math.floor((instant.getTime() - first.getTime()) / step) + 1;
      for (let i = 0; i < Math.min(count, MAX_COUNTED_OCCURRENCES); i++) list.push(new Date(first.getTime() + i * step));
      return { list, truncated: count > MAX_COUNTED_OCCURRENCES };
    }
    let cursor: Date | null = first;
    while (cursor && cursor.getTime() <= instant.getTime() && list.length < MAX_COUNTED_OCCURRENCES) {
      if (!isRepeatedWallTime(schedule.tz, cursor)) list.push(cursor);
      cursor = nextOccurrence(schedule, cursor);
    }
    return { list, truncated: cursor !== null && cursor.getTime() <= instant.getTime() };
  }

  /** The slot after `instant`, always strictly in the future and never counted from the start of the run. */
  function slotAfter(schedule: JobSchedule, scheduledFor: Date, instant: Date): Date | null {
    if (schedule.kind === "every") {
      const step = schedule.minutes * 60_000;
      return new Date(scheduledFor.getTime() + step * (Math.floor((instant.getTime() - scheduledFor.getTime()) / step) + 1));
    }
    return nextOccurrence(schedule, instant);
  }

  function processDue(jobId: string, instant: Date, previousTick: Date | null, out: TickResult) {
    db.transaction(() => {
      const job = readJob(jobId);
      if (!job || !job.enabled || job.deletedAt || !job.nextRunAt || job.nextRunAt.getTime() > instant.getTime()) return;
      const executor = options.executors[job.action.kind];
      const first = job.nextRunAt;
      const { list, truncated } = dueOccurrences(job.schedule, first, instant);
      const cause: MissedCause = !previousTick || instant.getTime() - previousTick.getTime() > 2 * TICK_INTERVAL_MS ? "down" : "stall";

      // Which occurrence runs. The others are lost and counted, never replayed.
      let chosen: Date | null = null;
      let lost = list.slice();
      if (list.length) {
        const limit = windowMs(job);
        if (job.schedule.kind === "cron" && job.action.kind !== "card") {
          const last = list[list.length - 1];
          if (instant.getTime() - last.getTime() <= (limit ?? Infinity)) { chosen = last; lost = list.slice(0, -1); }
        } else if (job.schedule.kind === "at" && job.action.kind !== "card") {
          const never = db.query("SELECT 1 FROM scheduled_job_runs WHERE job_id = ? AND status NOT IN ('missed','skipped') LIMIT 1").get(job.id) === null;
          if (never && instant.getTime() - list[0].getTime() <= (limit ?? Infinity)) { chosen = list[0]; lost = []; }
        } else { chosen = list[0]; lost = list.slice(1); }
      }

      // A command or agent that is still running makes an `every` job wait: it restarts when the run ends.
      const busy = chosen ? hasOpenRun(job.id) || (executor?.isBusy?.(job) ?? false) : false;
      if (busy && job.schedule.kind === "every" && job.action.kind !== "card") return;

      const lostCount = lost.length + (truncated ? 1 : 0);
      if (lostCount > 0) {
        insertRun(job, `missed:${lost[0]?.toISOString() ?? first.toISOString()}`, lost[0] ?? first, "missed", { cause: busy ? "overlap" : cause, missed: lostCount }, instant);
      }
      if (chosen) {
        if (busy) {
          insertRun(job, chosen.toISOString(), chosen, "skipped", { cause: "overlap", reason: job.action.kind === "card" ? "La card precedente è ancora aperta." : "Il giro precedente è ancora in corso." }, instant);
          out.skipped.push(job.id);
        } else {
          const run = insertRun(job, chosen.toISOString(), chosen, "pending", {}, instant);
          if (run && executor?.atomic) {
            const result = launch(run, instant);
            if (result?.taskId) out.created.push(result.taskId);
          }
        }
      }
      const next = job.schedule.kind === "at" ? null : slotAfter(job.schedule, first, instant);
      db.prepare("UPDATE scheduled_jobs SET next_run_at = ?, enabled = ?, updated_at = ? WHERE id = ?")
        .run(next ? next.toISOString() : null, job.schedule.kind === "at" ? 0 : job.enabled ? 1 : 0, instant.toISOString(), job.id);
    }).immediate();
  }

  /** `starting` rows that never got a process or a turn within the grace do not block the next occurrences. */
  function failStaleStarting(instant: Date) {
    db.prepare(`UPDATE scheduled_job_runs SET status = 'failed_to_start', finished_at = ?, reason = 'Never started.'
      WHERE status = 'starting' AND process_ref IS NULL AND task_id IS NULL AND started_at < ?`)
      .run(instant.toISOString(), new Date(instant.getTime() - STARTING_GRACE_MS).toISOString());
  }

  /** Rows `pending` (taken by this or another engine, not launched yet) move on at every tick, within the cap. */
  function advancePending(instant: Date, out: TickResult) {
    const pending = db.query("SELECT * FROM scheduled_job_runs WHERE status = 'pending' ORDER BY scheduled_for, id").all() as RunRow[];
    let open = (db.query(`SELECT COUNT(*) AS n FROM scheduled_job_runs r JOIN scheduled_jobs j ON j.id = r.job_id
      WHERE r.status IN ('starting','running') AND json_extract(j.action_json, '$.kind') != 'card'`).get() as { n: number }).n;
    const cap = maxConcurrent();
    for (const row of pending) {
      const job = readJob(row.job_id);
      if (job && job.action.kind !== "card") {
        if (open >= cap) continue;
        open += 1;
      }
      const result = launch(parseRun(row), instant);
      if (result?.taskId) out.created.push(result.taskId);
      if (result) out.started.push(row.id);
    }
  }

  /** Each executor reconciles its open runs. One that throws must not hold the others back. */
  function sweepExecutors(instant: Date) {
    for (const executor of Object.values(options.executors)) {
      try { executor?.sweep?.(instant); } catch (error) { console.warn("[schedule] sweep failed:", error); }
    }
  }

  /** R14: closed runs older than the history window go, at most once an hour. */
  function pruneHistory(instant: Date) {
    if (instant.getTime() - lastPruneAt < PRUNE_EVERY_MS) return;
    lastPruneAt = instant.getTime();
    db.prepare("DELETE FROM scheduled_job_runs WHERE finished_at IS NOT NULL AND finished_at < ?")
      .run(new Date(instant.getTime() - HISTORY_DAYS * 86_400_000).toISOString());
  }

  function tick(): TickResult {
    const out: TickResult = { created: [], skipped: [], started: [] };
    // Every caller asks the role, not only the timer: a run that closes calls tick too.
    if (startsPaused || !active()) return out;
    const instant = now();
    const previousTick = lastTickAt();
    writeHeartbeat(instant);
    failStaleStarting(instant);
    sweepExecutors(instant);
    pruneHistory(instant);
    const due = db.query("SELECT id FROM scheduled_jobs WHERE enabled = 1 AND deleted_at IS NULL AND next_run_at <= ? ORDER BY next_run_at, id")
      .all(instant.toISOString()) as { id: string }[];
    for (const { id } of due) {
      try {
        processDue(id, instant, previousTick, out);
      } catch (error) {
        // A job with broken data must not hold the others back: it is switched off and the failure is recorded.
        db.prepare("UPDATE scheduled_jobs SET enabled = 0, next_run_at = NULL, updated_at = ? WHERE id = ?").run(instant.toISOString(), id);
        console.error("[schedule] job switched off after an error", id, error);
      }
    }
    advancePending(instant, out);
    try { options.onTick?.(instant); } catch (error) { console.warn("[schedule] after-tick hook failed:", error); }
    return out;
  }

  /** Closes a run the action reported over. A job that was waiting on it restarts right away (R9). */
  function finishRun(runId: string, status: Extract<RunStatus, "ok" | "error" | "timeout" | "cancelled" | "interrupted">, reason?: string): TickResult {
    db.prepare("UPDATE scheduled_job_runs SET status = ?, finished_at = ?, reason = COALESCE(?, reason) WHERE id = ? AND status IN ('starting','running')")
      .run(status, now().toISOString(), reason ?? null, runId);
    return tick();
  }

  /** A run still open, closed as `status` only if nobody closed it first. True when this call closed it. */
  function closeIfOpen(runId: string, status: RunStatus, reason: string | null, extra: { exitCode?: number | null; stdoutTail?: string; stderrTail?: string } = {}): boolean {
    return db.prepare(`UPDATE scheduled_job_runs SET status = ?, finished_at = ?, reason = COALESCE(?, reason),
      exit_code = COALESCE(?, exit_code), stdout_tail = COALESCE(?, stdout_tail), stderr_tail = COALESCE(?, stderr_tail)
      WHERE id = ? AND status IN ('pending','starting','running')`)
      .run(status, now().toISOString(), reason, extra.exitCode ?? null, extra.stdoutTail ?? null, extra.stderrTail ?? null, runId).changes === 1;
  }

  /** R25: a job that is deleted or cancelled stops the run in flight: `cancelled` first, then the process, and nothing is delivered. */
  function cancelOpenRuns(jobId: string, reason: string): number {
    const job = readJob(jobId);
    const open = db.query("SELECT * FROM scheduled_job_runs WHERE job_id = ? AND status IN ('pending','starting','running')").all(jobId) as RunRow[];
    let cancelled = 0;
    for (const row of open) {
      if (!closeIfOpen(row.id, "cancelled", reason)) continue;
      cancelled++;
      if (job) try { options.executors[job.action.kind]?.stop?.(job, parseRun(row)); } catch (error) { console.warn("[schedule] stop failed:", error); }
    }
    return cancelled;
  }

  /** R5: `run now` has its own key and never moves `next_run_at`. */
  function runNow(jobId: string): ScheduledRun | null {
    const job = readJob(jobId);
    if (!job || job.deletedAt || awaitingOwner(jobId)) return null;
    const at = now();
    const run = insertRun(job, `manual:${crypto.randomUUID()}`, at, "pending", {}, at);
    if (!run) return null;
    tick();
    return parseRun(db.query("SELECT * FROM scheduled_job_runs WHERE id = ?").get(run.id) as RunRow);
  }

  /** Runs that hold a slot: what a shutdown or a planned restart has to wait for (R28). */
  /** The runs that hold a slot, one by one: what a primary switch waits for or parks. */
  function inFlightRuns(): Array<{ runId: string; jobId: string }> {
    return (db.query("SELECT id, job_id FROM scheduled_job_runs WHERE status IN ('starting','running') ORDER BY id").all() as { id: string; job_id: string }[])
      .map((r) => ({ runId: r.id, jobId: r.job_id }));
  }

  function inFlight(): number {
    return (db.query("SELECT COUNT(*) AS n FROM scheduled_job_runs WHERE status IN ('starting','running')").get() as { n: number }).n;
  }

  return {
    tick,
    finishRun,
    closeIfOpen,
    cancelOpenRuns,
    runNow,
    inFlight,
    inFlightRuns,
    /** R28: no occurrence starts while paused. Shutdown calls it before anything else. */
    pauseStarts() { startsPaused = true; },
    resumeStarts() { startsPaused = false; },
    isPaused: () => startsPaused,
    /** Starts the 15 s timer. `active` is asked at every beat: only the primary server decides. */
    start(isActive: () => boolean, onResult?: (result: TickResult) => void) {
      if (timer) return timer;
      active = isActive;
      timer = setInterval(() => {
        if (!active()) return;
        try { onResult?.(tick()); } catch (error) { console.warn("[scheduled-jobs] tick failed:", error); }
      }, TICK_INTERVAL_MS);
      return timer;
    },
    /** Stops the timer and the starts. First thing in the shutdown (R3). */
    stop() {
      startsPaused = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
