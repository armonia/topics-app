/**
 * The board's scheduled-cards door, on top of the engine. The routes and the
 * board menu keep the shape they always had; underneath, a recurrence is a job
 * with a `card` action and its history is the table of runs.
 */
import type { Database } from "bun:sqlite";
import { isTaskLabel, normalizeLabels } from "../../shared/task-labels";
import { DEFAULT_TIME_ZONE, nextCronOccurrence, ScheduleError, validateSchedule } from "../../shared/schedule";
import type { ScheduledCard, ScheduledStatus } from "../../shared/scheduled-cards";
import type { ScheduledJobRow, RunRow } from "./store";

export type { ScheduledCard } from "../../shared/scheduled-cards";

export class ScheduledCardsError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

type Input = { projectId: string; text: string; status: string; labels: unknown; cron: string; timeZone?: string };
type UpdateInput = Omit<Input, "projectId"> & { enabled?: boolean };

export interface ScheduledCardsService {
  create(input: Input): ScheduledCard;
  update(id: string, projectId: string, input: UpdateInput): ScheduledCard;
  setEnabled(id: string, projectId: string, enabled: boolean): ScheduledCard;
  remove(id: string, projectId: string): void;
  list(projectId: string): ScheduledCard[];
}

const CARD_JOBS = "json_extract(action_json, '$.kind') = 'card'";

function mapRow(row: ScheduledJobRow, last: RunRow | null): ScheduledCard {
  const schedule = JSON.parse(row.schedule_json) as { expr: string; tz: string };
  const action = JSON.parse(row.action_json) as { text: string; status: ScheduledStatus; labels: ScheduledCard["labels"] };
  return {
    id: row.id, projectId: row.project_id ?? "", text: action.text, status: action.status, labels: action.labels,
    cron: schedule.expr, timeZone: schedule.tz, enabled: row.enabled === 1, nextRunAt: row.next_run_at ?? "",
    lastRunAt: last?.created_at ?? null,
    // Only a run that linked a card created one: skipped and failed_to_start did not.
    lastResult: last ? (last.task_id ? "created" : "skipped") : null,
    lastReason: last && !last.task_id ? last.reason : null,
  };
}

export function createScheduledCardsService(db: Database, now: () => Date = () => new Date()): ScheduledCardsService {
  const read = (id: string) => db.query(`SELECT * FROM scheduled_jobs WHERE id = ? AND ${CARD_JOBS}`).get(id) as ScheduledJobRow | null;
  const lastRun = (id: string) => db.query("SELECT * FROM scheduled_job_runs WHERE job_id = ? AND status NOT IN ('missed') ORDER BY created_at DESC, rowid DESC LIMIT 1").get(id) as RunRow | null;
  const view = (id: string) => { const row = read(id)!; return mapRow(row, lastRun(id)); };
  const live = (id: string, projectId: string) => {
    const row = read(id);
    if (!row || row.project_id !== projectId || row.deleted_at) throw new ScheduledCardsError("Ricorrenza non trovata.", 404);
    return row;
  };

  function validate(input: Input) {
    if (typeof input.text !== "string" || typeof input.cron !== "string") throw new ScheduledCardsError("Testo e regola cron sono obbligatori.");
    if (input.timeZone !== undefined && typeof input.timeZone !== "string") throw new ScheduledCardsError("Fuso orario non valido.");
    const text = input.text.trim();
    if (!input.projectId || !text) throw new ScheduledCardsError("Board e testo sono obbligatori.");
    if (!["backlog", "todo", "in_progress", "review"].includes(input.status)) throw new ScheduledCardsError("Colonna non valida.");
    const labels = normalizeLabels(Array.isArray(input.labels) ? input.labels.filter(isTaskLabel) : []);
    let schedule;
    try { schedule = validateSchedule({ kind: "cron", expr: input.cron, tz: input.timeZone?.trim() || DEFAULT_TIME_ZONE }, { now: now() }); }
    catch (error) { throw error instanceof ScheduleError ? new ScheduledCardsError(error.message) : error; }
    if (schedule.kind !== "cron") throw new ScheduledCardsError("La regola deve essere un cron.");
    const next = nextCronOccurrence(schedule.expr, schedule.tz, now());
    return { text, status: input.status as ScheduledStatus, labels, schedule, next };
  }

  return {
    create(input) {
      const value = validate(input); const id = crypto.randomUUID(); const stamp = now().toISOString();
      db.prepare(`INSERT INTO scheduled_jobs (id, name, project_id, schedule_json, action_json, enabled, next_run_at, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, 'user', ?, ?)`)
        .run(id, value.text.slice(0, 120), input.projectId, JSON.stringify(value.schedule),
          JSON.stringify({ kind: "card", text: value.text, status: value.status, labels: value.labels }), value.next.toISOString(), stamp, stamp);
      return view(id);
    },
    update(id, projectId, input) {
      live(id, projectId);
      const value = validate({ ...input, projectId }); const stamp = now().toISOString();
      db.prepare("UPDATE scheduled_jobs SET name=?, schedule_json=?, action_json=?, enabled=?, next_run_at=?, updated_at=? WHERE id=? AND project_id=?")
        .run(value.text.slice(0, 120), JSON.stringify(value.schedule), JSON.stringify({ kind: "card", text: value.text, status: value.status, labels: value.labels }),
          input.enabled === false ? 0 : 1, value.next.toISOString(), stamp, id, projectId);
      return view(id);
    },
    setEnabled(id, projectId, enabled) {
      const current = live(id, projectId);
      const schedule = JSON.parse(current.schedule_json) as { expr: string; tz: string };
      const next = enabled ? nextCronOccurrence(schedule.expr, schedule.tz, now()).toISOString() : current.next_run_at;
      db.prepare("UPDATE scheduled_jobs SET enabled=?, next_run_at=?, updated_at=? WHERE id=? AND project_id=?")
        .run(enabled ? 1 : 0, next, now().toISOString(), id, projectId);
      return view(id);
    },
    remove(id, projectId) {
      db.prepare(`UPDATE scheduled_jobs SET enabled=0, deleted_at=?, updated_at=? WHERE id=? AND project_id=? AND deleted_at IS NULL AND ${CARD_JOBS}`)
        .run(now().toISOString(), now().toISOString(), id, projectId);
    },
    list(projectId) {
      return (db.query(`SELECT * FROM scheduled_jobs WHERE project_id = ? AND deleted_at IS NULL AND ${CARD_JOBS} ORDER BY created_at, id`).all(projectId) as ScheduledJobRow[])
        .map(row => mapRow(row, lastRun(row.id)));
    },
  };
}
