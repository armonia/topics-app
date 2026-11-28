/**
 * The door of scheduled jobs for the API (rule R25): create, change, delete,
 * run now, postpone, history. It validates; the engine decides when to run.
 *
 * Two rules from a failure of the old engine are enforced here and tested:
 * changing or postponing a recurring job never changes its kind, and nothing
 * here archives a recurring job on its own. A job leaves only through `remove`.
 */
import type { Database } from "bun:sqlite";
import { firstOccurrence, nextOccurrence, ScheduleError, validateSchedule, type JobSchedule } from "../../shared/schedule";
import { normalizeCommandAction } from "./command-spec";
import { parseJob, parseRun, type JobAction, type JobPolicy, type RunRow, type ScheduledJobRow } from "./store";

export class JobsError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const NAME_MAX = 120;
const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 500;

export interface JobsEngine {
  runNow(jobId: string): { id: string; status: string } | null;
  cancelOpenRuns(jobId: string, reason: string): number;
}

export interface JobsServiceOptions {
  engine: JobsEngine;
  now?: () => Date;
  /** The directory of a project, or null when it does not exist. */
  projectPath: (projectId: string) => string | null;
  /** `ask`: a job an agent creates is born paused. `auto`: only one with a delivery is (R26). Default `ask`. */
  agentJobMode?: () => "ask" | "auto";
  /** Called once for a job an agent created that was put in pause, so the person is told. */
  onPausedByAgent?: (job: { id: string; name: string }) => void;
}

/** The creator name an agent's tool writes (`agent:<session>`); the people and the importer write anything else. */
export const AGENT_CREATOR_PREFIX = "agent:";

export interface CreateInput {
  id?: unknown; name?: unknown; projectId?: unknown; schedule?: unknown; action?: unknown;
  deliver?: unknown; policy?: unknown; enabled?: unknown; createdBy?: unknown;
}
export type UpdateInput = Omit<CreateInput, "id" | "createdBy">;

export interface ScheduledJobView {
  id: string; name: string; projectId: string | null; schedule: JobSchedule; action: JobAction; deliver: unknown;
  policy: JobPolicy; enabled: boolean; nextRunAt: string | null; createdBy: string; createdAt: string; updatedAt: string;
  lastRun: RunView | null;
}
export interface RunView {
  id: string; jobId: string; occurrenceKey: string; scheduledFor: string; status: string; cause: string | null; reason: string | null;
  missedCount: number; processRef: string | null; startedAt: string | null; finishedAt: string | null;
  exitCode: number | null; stdout: string | null; stderr: string | null;
  /** What happened to the outcome outside the app (R22/R23); null while nothing was recorded for this run. */
  delivery: { state: string; detail: string | null } | null;
}

const kindOf = (schedule: JobSchedule) => schedule.kind === "at" ? "at" : "recurring";

function policyOf(value: unknown): JobPolicy {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new JobsError("policy must be an object.");
  const input = value as Record<string, unknown>;
  const policy: JobPolicy = {};
  if (input.windowMs !== undefined) {
    if (typeof input.windowMs !== "number" || !Number.isFinite(input.windowMs) || input.windowMs < 0) throw new JobsError("policy.windowMs must be a number of milliseconds.");
    policy.windowMs = input.windowMs;
  }
  if (input.repeatable !== undefined) {
    if (typeof input.repeatable !== "boolean") throw new JobsError("policy.repeatable must be true or false.");
    policy.repeatable = input.repeatable;
  }
  return policy;
}

export function createJobsService(db: Database, options: JobsServiceOptions) {
  const now = options.now ?? (() => new Date());

  const read = (id: string) => db.query("SELECT * FROM scheduled_jobs WHERE id = ?").get(id) as ScheduledJobRow | null;
  const live = (id: string) => {
    const row = read(id);
    if (!row || row.deleted_at) throw new JobsError("Job not found.", 404);
    return row;
  };
  const lastRunOf = (id: string) => db.query("SELECT * FROM scheduled_job_runs WHERE job_id = ? AND status != 'missed' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(id) as RunRow | null;

  // The register keys a run's delivery on the run id.
  const deliveryOf = (runId: string) => db.query("SELECT state, detail FROM deliveries WHERE key = ?").get(runId) as { state: string; detail: string | null } | null;

  function runView(row: RunRow): RunView {
    const run = parseRun(row);
    return {
      id: run.id, jobId: run.jobId, occurrenceKey: run.occurrenceKey, scheduledFor: run.scheduledFor.toISOString(), status: run.status,
      cause: run.cause, reason: run.reason, missedCount: run.missedCount, processRef: run.processRef,
      startedAt: row.started_at, finishedAt: row.finished_at, exitCode: row.exit_code ?? null, stdout: row.stdout_tail ?? null, stderr: row.stderr_tail ?? null,
      delivery: deliveryOf(run.id),
    };
  }

  function view(row: ScheduledJobRow): ScheduledJobView {
    const job = parseJob(row);
    const last = lastRunOf(row.id);
    return {
      id: job.id, name: job.name, projectId: job.projectId, schedule: job.schedule, action: job.action,
      deliver: row.deliver_json ? JSON.parse(row.deliver_json) : null, policy: job.policy, enabled: job.enabled,
      nextRunAt: row.next_run_at, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at,
      lastRun: last ? runView(last) : null,
    };
  }

  function parseSchedule(value: unknown, onlyFuture: boolean): JobSchedule {
    try { return validateSchedule(value, { now: now(), rejectPast: onlyFuture }); }
    catch (error) { throw error instanceof ScheduleError ? new JobsError(error.message) : error; }
  }

  function parseAction(value: unknown): JobAction {
    const kind = (value as { kind?: unknown } | null)?.kind;
    if (kind !== "command") throw new JobsError("Only the command action can be created here for now.");
    try { return normalizeCommandAction(value); }
    catch (error) { throw error instanceof ScheduleError ? new JobsError(error.message) : error; }
  }

  function checkWhere(projectId: string | null, action: JobAction) {
    if (projectId && !options.projectPath(projectId)) throw new JobsError("Unknown project.");
    if (action.kind === "command" && !action.cwd && !projectId) throw new JobsError("A command needs a directory (cwd) or a project.");
  }

  function parseName(value: unknown): string {
    const name = typeof value === "string" ? value.trim() : "";
    if (!name) throw new JobsError("A job needs a name.");
    return name.slice(0, NAME_MAX);
  }

  const projectOf = (value: unknown): string | null => {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string") throw new JobsError("projectId must be text.");
    return value;
  };

  /** The deliver block is stored as given; the delivery track gives it its meaning. */
  const deliverOf = (value: unknown): string | null => {
    if (value === undefined || value === null) return null;
    if (typeof value !== "object" || Array.isArray(value)) throw new JobsError("deliver must be an object.");
    return JSON.stringify(value);
  };

  return {
    list(filter: { projectId?: string } = {}): ScheduledJobView[] {
      const rows = filter.projectId
        ? db.query("SELECT * FROM scheduled_jobs WHERE deleted_at IS NULL AND project_id = ? ORDER BY created_at, id").all(filter.projectId)
        : db.query("SELECT * FROM scheduled_jobs WHERE deleted_at IS NULL ORDER BY created_at, id").all();
      return (rows as ScheduledJobRow[]).map(view);
    },

    get(id: string): ScheduledJobView { return view(live(id)); },

    /** With an id and an initial state given, so an importer can bring jobs over as they were (R31). */
    create(input: CreateInput): ScheduledJobView {
      const name = parseName(input.name);
      const asked = input.enabled === undefined ? true : input.enabled;
      if (typeof asked !== "boolean") throw new JobsError("enabled must be true or false.");
      let enabled: boolean = asked;
      const createdBy = typeof input.createdBy === "string" && input.createdBy.trim() ? input.createdBy.trim().slice(0, 80) : "user";
      // R26: a job an agent makes with a delivery is always born in pause; with `ask` every one is. Not a security fence: an agent already has a shell.
      const byAgent = createdBy.startsWith(AGENT_CREATOR_PREFIX);
      const pausedByAgent = byAgent && enabled && (input.deliver != null || (options.agentJobMode?.() ?? "ask") === "ask");
      if (pausedByAgent) enabled = false;
      // The state the caller ASKED for decides about the past: a job an agent pauses still has to be a job that can run once turned on.
      const schedule = parseSchedule(input.schedule, asked);
      const action = parseAction(input.action);
      const projectId = projectOf(input.projectId);
      checkWhere(projectId, action);
      let id: string;
      if (input.id === undefined) id = crypto.randomUUID();
      else if (typeof input.id === "string" && JOB_ID.test(input.id)) {
        id = input.id;
        if (read(id)) throw new JobsError("A job with this id already exists.", 409);
      } else throw new JobsError("The id is not valid.");
      const at = now();
      const next = enabled ? firstOccurrence(schedule, at) : null;
      const deliver = deliverOf(input.deliver);
      db.prepare(`INSERT INTO scheduled_jobs (id, name, project_id, schedule_json, action_json, deliver_json, deliver_since, policy_json, enabled, awaiting_owner, next_run_at, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, name, projectId, JSON.stringify(schedule), JSON.stringify(action), deliver, deliver ? at.toISOString() : null, JSON.stringify(policyOf(input.policy)),
          enabled ? 1 : 0, pausedByAgent ? 1 : 0, next?.toISOString() ?? null, createdBy, at.toISOString(), at.toISOString());
      if (pausedByAgent) options.onPausedByAgent?.({ id, name });
      return view(read(id)!);
    },

    /** A change never turns a recurring job into a one-time one or the other way, and never changes the kind of its action. */
    update(id: string, input: UpdateInput): ScheduledJobView {
      const row = live(id);
      const current = parseJob(row);
      const name = input.name === undefined ? current.name : parseName(input.name);
      const schedule = input.schedule === undefined ? current.schedule : parseSchedule(input.schedule, false);
      if (kindOf(schedule) !== kindOf(current.schedule)) throw new JobsError("A job cannot change between recurring and one-time.");
      const action = input.action === undefined ? current.action : parseAction(input.action);
      if (action.kind !== current.action.kind) throw new JobsError("A job cannot change the kind of its action.");
      const projectId = input.projectId === undefined ? current.projectId : projectOf(input.projectId);
      checkWhere(projectId, action);
      const enabled = input.enabled === undefined ? current.enabled : input.enabled;
      if (typeof enabled !== "boolean") throw new JobsError("enabled must be true or false.");
      const policy = input.policy === undefined ? current.policy : policyOf(input.policy);
      const at = now();
      const scheduleChanged = JSON.stringify(schedule) !== JSON.stringify(current.schedule);
      const reEnabled = enabled && !current.enabled;
      // A one-time job turned on (or moved) while its instant is gone would be accepted and never run.
      if (enabled && schedule.kind === "at" && (scheduleChanged || reEnabled)) parseSchedule(schedule, true);
      let next = row.next_run_at;
      if (enabled && (scheduleChanged || reEnabled || !next)) next = firstOccurrence(schedule, at)?.toISOString() ?? null;
      const deliver = input.deliver === undefined ? row.deliver_json : deliverOf(input.deliver);
      // Only runs that finish after the delivery was added or changed are sent.
      const deliverSince = !deliver ? null : deliver === row.deliver_json ? row.deliver_since : at.toISOString();
      // A person turning the job on is the answer R26 waits for.
      const awaitingOwner = enabled ? 0 : row.awaiting_owner;
      db.prepare("UPDATE scheduled_jobs SET name=?, project_id=?, schedule_json=?, action_json=?, deliver_json=?, deliver_since=?, policy_json=?, enabled=?, awaiting_owner=?, next_run_at=?, updated_at=? WHERE id=?")
        .run(name, projectId, JSON.stringify(schedule), JSON.stringify(action), deliver, deliverSince, JSON.stringify(policy), enabled ? 1 : 0, awaitingOwner, next, at.toISOString(), id);
      return view(read(id)!);
    },

    /** Deleting stops the run in flight (`cancelled`, nothing delivered) and keeps the history. */
    remove(id: string): void {
      live(id);
      const at = now().toISOString();
      db.prepare("UPDATE scheduled_jobs SET enabled = 0, deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(at, at, id);
      options.engine.cancelOpenRuns(id, "The job was deleted.");
    },

    runNow(id: string): RunView {
      if (live(id).awaiting_owner) throw new JobsError("This job was created by an agent and waits for the owner to turn it on.", 409);
      const run = options.engine.runNow(id);
      if (!run) throw new JobsError("The run could not be created.", 409);
      return runView(db.query("SELECT * FROM scheduled_job_runs WHERE id = ?").get(run.id) as RunRow);
    },

    /**
     * Moves the NEXT occurrence only. The schedule, the kind and `enabled` stay
     * as they are, so the job goes on at its usual times afterwards. The new time
     * cannot pass the occurrence after the next: that would skip one.
     */
    postpone(id: string, input: { until?: unknown; minutes?: unknown }): ScheduledJobView {
      const row = live(id);
      const job = parseJob(row);
      if (!job.enabled || !job.nextRunAt) throw new JobsError("Only a job that is waiting for its next occurrence can be postponed.", 409);
      const at = now();
      let until: Date;
      if (typeof input.minutes === "number" && Number.isFinite(input.minutes) && input.minutes > 0) until = new Date(job.nextRunAt.getTime() + input.minutes * 60_000);
      else if (typeof input.until === "string" && !Number.isNaN(Date.parse(input.until))) until = new Date(input.until);
      else throw new JobsError("Say `minutes` or `until`.");
      if (until.getTime() <= at.getTime()) throw new JobsError("The new time is in the past.");
      if (until.getTime() <= job.nextRunAt.getTime()) throw new JobsError("A postponed occurrence moves later, not earlier.");
      if (job.schedule.kind !== "at") {
        const following = nextOccurrence(job.schedule, job.nextRunAt);
        if (following && until.getTime() > following.getTime()) throw new JobsError("An occurrence cannot be postponed past the one after it.");
      }
      const schedule = job.schedule.kind === "at" ? { kind: "at" as const, at: until.toISOString() } : job.schedule;
      db.prepare("UPDATE scheduled_jobs SET next_run_at = ?, schedule_json = ?, updated_at = ? WHERE id = ?").run(until.toISOString(), JSON.stringify(schedule), at.toISOString(), id);
      return view(read(id)!);
    },

    runs(id: string, limit?: number): RunView[] {
      const bounded = Math.min(Math.max(Math.floor(limit ?? DEFAULT_HISTORY_LIMIT) || DEFAULT_HISTORY_LIMIT, 1), MAX_HISTORY_LIMIT);
      if (!read(id)) throw new JobsError("Job not found.", 404);
      return (db.query("SELECT * FROM scheduled_job_runs WHERE job_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(id, bounded) as RunRow[]).map(runView);
    },
  };
}
