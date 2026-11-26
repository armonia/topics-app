/** Row shapes of `scheduled_jobs` and `scheduled_job_runs`, and their parsed form. */
import type { JobSchedule } from "../../shared/schedule";
import type { ScheduledStatus } from "../../shared/scheduled-cards";

export type RunStatus = "pending" | "starting" | "running" | "ok" | "error" | "timeout" | "cancelled" | "skipped" | "missed" | "failed_to_start" | "interrupted";
export type MissedCause = "down" | "stall" | "provider" | "cap" | "paused";

/** What a `command` job runs: an argv (no shell), the text it reads on stdin, a hard time limit that is always written. */
export interface CommandJobAction {
  kind: "command";
  argv: string[];
  stdin: string | null;
  /** Absolute directory; when absent the project of the job. */
  cwd: string | null;
  env: Record<string, string>;
  timeoutSec: number;
}

/** `agent` arrives in a later track; the engine already carries its kind. */
export type JobAction =
  | { kind: "card"; text: string; status: ScheduledStatus; labels: string[] }
  | CommandJobAction
  | { kind: "agent"; [key: string]: unknown };

export interface JobPolicy {
  /** Overrides the default catch-up window for this job. */
  windowMs?: number;
  /** False: a run lost with its process is never started again (R12). Absent means it can be. */
  repeatable?: boolean;
}

export interface ScheduledJobRow {
  id: string; name: string; project_id: string | null; schedule_json: string; action_json: string;
  deliver_json: string | null; policy_json: string; enabled: number; next_run_at: string | null;
  created_by: string; created_at: string; updated_at: string; deleted_at: string | null;
}

export interface RunRow {
  id: string; job_id: string; occurrence_key: string; scheduled_for: string; status: RunStatus;
  cause: string | null; reason: string | null; missed_count: number; task_id: string | null;
  process_ref: string | null; created_at: string; started_at: string | null; finished_at: string | null;
  exit_code: number | null; stdout_tail: string | null; stderr_tail: string | null;
}

export interface ScheduledJob {
  id: string; name: string; projectId: string | null; schedule: JobSchedule; action: JobAction; policy: JobPolicy;
  enabled: boolean; nextRunAt: Date | null; deletedAt: string | null;
}

export interface ScheduledRun {
  id: string; jobId: string; occurrenceKey: string; scheduledFor: Date; status: RunStatus;
  cause: string | null; reason: string | null; missedCount: number; taskId: string | null;
  processRef: string | null; startedAt: Date | null; exitCode: number | null;
}

export function parseJob(row: ScheduledJobRow): ScheduledJob {
  return {
    id: row.id, name: row.name, projectId: row.project_id,
    schedule: JSON.parse(row.schedule_json) as JobSchedule,
    action: JSON.parse(row.action_json) as JobAction,
    policy: JSON.parse(row.policy_json) as JobPolicy,
    enabled: row.enabled === 1,
    nextRunAt: row.next_run_at ? new Date(row.next_run_at) : null,
    deletedAt: row.deleted_at,
  };
}

export function parseRun(row: RunRow): ScheduledRun {
  return {
    id: row.id, jobId: row.job_id, occurrenceKey: row.occurrence_key, scheduledFor: new Date(row.scheduled_for),
    status: row.status, cause: row.cause, reason: row.reason, missedCount: row.missed_count, taskId: row.task_id,
    processRef: row.process_ref, startedAt: row.started_at ? new Date(row.started_at) : null, exitCode: row.exit_code ?? null,
  };
}
