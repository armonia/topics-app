/**
 * WHAT A FINISHED RUN SENDS, AND WHEN A JOB HAS BROKEN (rules R22 and R24).
 *
 * `sweep` runs at the end of every engine tick. It reads the finished runs of
 * jobs that have a `deliver` block and no register row yet, so a restart
 * between the end of a run and its delivery loses nothing and sends nothing
 * twice (the register keys on the run id). What goes out:
 *  - stdout of the command, first 4000 characters; empty or `NO_REPLY` sends nothing;
 *  - a non-zero exit is an error and its stdout still goes; stderr never;
 *  - a failed command with no output says one line, only if the run before it went well;
 *  - a run that timed out or was cancelled sends nothing (partial output is not delivered).
 * Then it counts failures in a row per job and raises the alert (R24).
 */
import type { Database } from "bun:sqlite";
import { jobSubject } from "../../../shared/attention";
import type { RunRow, ScheduledJobRow } from "../store";
import type { OwnerAlert } from "./owner-alert";
import type { Destination, DeliverySettings } from "./settings";
import type { Sender } from "./send";

export const DELIVERED_CHARS = 4000;
export const FAILURES_BEFORE_ALERT = 3;
const NO_REPLY = "NO_REPLY";
const AUTOMATION_FAILED = "AUTOMATION_FAILED";
/** Runs that finished longer ago than this are history, not something to send now (a first start after an upgrade). */
const FRESH_MS = 24 * 3_600_000;
const COUNTED_STATUSES = "'ok','error','timeout','failed_to_start'";

export interface RunDeliveryOptions {
  db: Database;
  sender: Sender;
  alert: OwnerAlert;
  settings: () => DeliverySettings;
  now?: () => Date;
}

/** `{ "to": "owner" }` or an explicit `{ channel, chat, thread }`. */
function destinationOf(deliver: unknown, settings: DeliverySettings): Destination | null {
  const block = (deliver && typeof deliver === "object" ? deliver : {}) as Record<string, unknown>;
  if (block.to === "owner") return settings.owner;
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  if (!text(block.channel) && !text(block.chat)) return null;
  return { channel: text(block.channel), chat: text(block.chat), thread: text(block.thread) };
}

/** The text of a run, or null when nothing should be said. */
export function textToSend(run: Pick<RunRow, "status" | "stdout_tail" | "exit_code">, jobName: string, previousWasOk: boolean): string | null {
  if (run.status !== "ok" && run.status !== "error") return null;
  let out = (run.stdout_tail ?? "").trim();
  // The agent track writes a failure marker on the first line: the marker is not for the person.
  if (out.startsWith(AUTOMATION_FAILED)) out = out.split("\n").slice(1).join("\n").trim();
  if (out === NO_REPLY) return null;
  if (out) return out.slice(0, DELIVERED_CHARS);
  if (run.status === "error" && previousWasOk) return `${jobName}: the command failed (exit code ${run.exit_code ?? "unknown"}).`;
  return null;
}

export function createRunDelivery(options: RunDeliveryOptions) {
  const { db } = options;
  const now = options.now ?? (() => new Date());
  let sweeping = false;

  const previousWasOk = (run: RunRow) => {
    const before = db.query(`SELECT status FROM scheduled_job_runs WHERE job_id = ? AND status IN (${COUNTED_STATUSES}) AND id != ? AND (finished_at < ? OR (finished_at = ? AND rowid < (SELECT rowid FROM scheduled_job_runs WHERE id = ?)))
      ORDER BY finished_at DESC, rowid DESC LIMIT 1`).get(run.job_id, run.id, run.finished_at, run.finished_at, run.id) as { status: string } | null;
    return before?.status === "ok";
  };

  async function deliverRuns() {
    const since = new Date(now().getTime() - FRESH_MS).toISOString();
    const rows = db.query(`SELECT r.* FROM scheduled_job_runs r JOIN scheduled_jobs j ON j.id = r.job_id
      WHERE j.deliver_json IS NOT NULL AND r.finished_at IS NOT NULL AND r.finished_at > ?
        AND r.status IN ('ok','error','timeout','cancelled')
        AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.key = r.id) ORDER BY r.finished_at, r.rowid`).all(since) as RunRow[];
    const settings = options.settings();
    for (const run of rows) {
      const job = db.query("SELECT * FROM scheduled_jobs WHERE id = ?").get(run.job_id) as ScheduledJobRow;
      const text = textToSend(run, job.name, previousWasOk(run));
      if (text === null) {
        // `record` keeps its answer: a run with nothing to say is closed here once.
        const registry = options.sender.registry;
        registry.record(run.id, "run", "empty", run.status === "ok" || run.status === "error" ? "Nothing to say." : `Run ${run.status}: nothing is delivered.`);
        continue;
      }
      const destination = destinationOf(JSON.parse(job.deliver_json!), settings);
      if (!destination) { options.sender.registry.record(run.id, "run", "not_delivered", "The job names no destination."); continue; }
      await options.sender({ key: run.id, kind: "run", text, values: { ...destination, title: job.name, jobId: job.id, runId: run.id } });
    }
  }

  /** Three counted runs in a row, all errors. `skipped`, `missed`, `interrupted` and `cancelled` are not in the count. */
  function failureStreak(jobId: string): number {
    const last = db.query(`SELECT status FROM scheduled_job_runs WHERE job_id = ? AND status IN (${COUNTED_STATUSES}) ORDER BY finished_at DESC, rowid DESC LIMIT ?`)
      .all(jobId, FAILURES_BEFORE_ALERT) as { status: string }[];
    let streak = 0;
    for (const { status } of last) { if (status === "ok") break; streak++; }
    return streak;
  }

  function alertBrokenJobs() {
    const since = new Date(now().getTime() - FRESH_MS).toISOString();
    const jobs = db.query(`SELECT DISTINCT j.id, j.name FROM scheduled_jobs j JOIN scheduled_job_runs r ON r.job_id = j.id
      WHERE j.deleted_at IS NULL AND r.status IN ('error','timeout','failed_to_start') AND r.finished_at > ?`).all(since) as { id: string; name: string }[];
    for (const job of jobs) {
      if (failureStreak(job.id) < FAILURES_BEFORE_ALERT) continue;
      options.alert({
        subject: jobSubject(job.id), scope: `job:${job.id}`, jobId: job.id,
        title: `${job.name} has failed ${FAILURES_BEFORE_ALERT} times in a row`,
        body: "The scheduled job keeps ending in error. Open its history to read the last outputs.",
      });
    }
  }

  return {
    failureStreak,
    /** Never reentrant: a slow adapter does not pile up sweeps. */
    async sweep(): Promise<void> {
      if (sweeping) return;
      sweeping = true;
      try { alertBrokenJobs(); await deliverRuns(); } finally { sweeping = false; }
    },
  };
}
