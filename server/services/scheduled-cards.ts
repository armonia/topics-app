import type { Database } from "bun:sqlite";
import { isTaskLabel, normalizeLabels, type TaskLabel } from "../../shared/task-labels";
import type { TaskService } from "./tasks";
import type { ScheduledCard, ScheduledStatus } from "../../shared/scheduled-cards";

export type { ScheduledCard } from "../../shared/scheduled-cards";

export class ScheduledCardsError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export interface ScheduledCardsService {
  create(input: { projectId: string; text: string; status: string; labels: unknown; cron: string; timeZone?: string }): ScheduledCard;
  update(id: string, projectId: string, input: { text: string; status: string; labels: unknown; cron: string; timeZone?: string; enabled?: boolean }): ScheduledCard;
  setEnabled(id: string, projectId: string, enabled: boolean): ScheduledCard;
  remove(id: string, projectId: string): void;
  list(projectId: string): ScheduledCard[];
  tick(): { created: string[]; skipped: string[] };
}

interface ScheduledRow {
  id: string; project_id: string; text: string; status: ScheduledStatus; labels_json: string;
  cron: string; time_zone: string; enabled: number; next_run_at: string; last_run_at: string | null;
  last_result: "created" | "skipped" | null; last_reason: string | null; last_occurrence_key: string | null;
  deleted_at: string | null;
}

const FIELDS = [
  { min: 0, max: 59 }, { min: 0, max: 23 }, { min: 1, max: 31 },
  { min: 1, max: 12 }, { min: 0, max: 7 },
] as const;

function parseCron(expression: string): Set<number>[] {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new ScheduledCardsError("La regola deve avere cinque campi cron.");
  return parts.map((part, index) => {
    const { min, max } = FIELDS[index];
    const values = new Set<number>();
    for (const term of part.split(",")) {
      const [rangeText, stepText] = term.split("/");
      if (term.split("/").length > 2 || (stepText && !/^\d+$/.test(stepText))) throw new ScheduledCardsError("Campo cron non valido.");
      const step = stepText ? Number(stepText) : 1;
      if (step < 1) throw new ScheduledCardsError("Il passo cron deve essere positivo.");
      let start: number; let end: number;
      if (rangeText === "*") { start = min; end = max; }
      else if (/^\d+$/.test(rangeText)) { start = Number(rangeText); end = term.includes("/") ? max : start; }
      else {
        const range = /^(\d+)-(\d+)$/.exec(rangeText);
        if (!range) throw new ScheduledCardsError("Campo cron non valido.");
        start = Number(range[1]); end = Number(range[2]);
      }
      if (start < min || end > max || start > end) throw new ScheduledCardsError("Valore cron fuori intervallo.");
      for (let value = start; value <= end; value += step) values.add(value);
    }
    if (index === 4 && values.has(7)) values.add(0);
    if (!values.size) throw new ScheduledCardsError("Campo cron vuoto.");
    return values;
  });
}

function zonedDateParts(instant: Date, clockFormat: Intl.DateTimeFormat) {
  const parts = clockFormat.formatToParts(instant);
  const get = (type: string) => Number(parts.find(part => part.type === type)?.value ?? "0");
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

function nextOccurrence(expression: string, timeZone: string, after: Date): Date {
  let parsed: Set<number>[];
  let clockFormat: Intl.DateTimeFormat;
  try {
    parsed = parseCron(expression);
    clockFormat = new Intl.DateTimeFormat("en-GB", {
      timeZone, year: "numeric", month: "numeric", day: "numeric", weekday: "short",
      hour: "numeric", minute: "numeric", hourCycle: "h23",
    });
  }
  catch { throw new ScheduledCardsError("Fuso orario o regola cron non validi."); }
  const afterLocal = zonedDateParts(after, clockFormat);
  const firstDate = new Date(Date.UTC(afterLocal.year, afterLocal.month - 1, afterLocal.day) - 86_400_000);
  const [minutes, hours, days, months, weekdays] = parsed;
  const fieldsText = expression.trim().split(/\s+/);
  const anyDay = fieldsText[2] === "*";
  const anyWeekday = fieldsText[4] === "*";
  for (let offsetDay = 0; offsetDay <= 8 * 366 + 3; offsetDay++) {
    const date = new Date(firstDate.getTime() + offsetDay * 86_400_000);
    const year = date.getUTCFullYear(); const month = date.getUTCMonth() + 1; const day = date.getUTCDate();
    const weekday = date.getUTCDay();
    if (!months.has(month)) continue;
    const dateMatches = days.has(day); const weekdayMatches = weekdays.has(weekday);
    if (!(anyDay ? weekdayMatches : anyWeekday ? dateMatches : dateMatches || weekdayMatches)) continue;

    // Sample nearby offsets to handle DST transitions without scanning every minute.
    const wallNoon = Date.UTC(year, month - 1, day, 12);
    const offsets = new Set<number>();
    for (let delta = -36; delta <= 36; delta += 6) {
      const sample = new Date(wallNoon + delta * 3_600_000);
      const local = zonedDateParts(sample, clockFormat);
      const sampleMinute = Math.floor(sample.getTime() / 60_000) * 60_000;
      offsets.add(Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute) - sampleMinute);
    }

    let first: number | null = null;
    for (const hour of hours) for (const minute of minutes) for (const zoneOffset of offsets) {
      const timestamp = Date.UTC(year, month - 1, day, hour, minute) - zoneOffset;
      if (timestamp <= after.getTime() || (first !== null && timestamp >= first)) continue;
      const candidate = new Date(timestamp);
      const local = zonedDateParts(candidate, clockFormat);
      if (local.year === year && local.month === month && local.day === day && local.hour === hour && local.minute === minute) first = timestamp;
    }
    if (first !== null) return new Date(first);
  }
  throw new ScheduledCardsError("La regola non ha esecuzioni nei prossimi otto anni.");
}

function occurrenceKey(instant: Date, timeZone: string): string {
  const p = new Intl.DateTimeFormat("sv-SE", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(instant);
  return p.replace(" ", "T");
}

function mapRow(row: ScheduledRow): ScheduledCard {
  return {
    id: row.id, projectId: row.project_id, text: row.text, status: row.status,
    labels: JSON.parse(row.labels_json) as TaskLabel[], cron: row.cron, timeZone: row.time_zone,
    enabled: row.enabled === 1, nextRunAt: row.next_run_at, lastRunAt: row.last_run_at,
    lastResult: row.last_result, lastReason: row.last_reason,
  };
}

export function createScheduledCards(db: Database, tasks: TaskService, now: () => Date = () => new Date()) {
  const read = (id: string) => db.query("SELECT * FROM scheduled_cards WHERE id = ?").get(id) as ScheduledRow | null;
  const list = (projectId: string) => (db.query("SELECT * FROM scheduled_cards WHERE project_id = ? AND deleted_at IS NULL ORDER BY created_at, id").all(projectId) as ScheduledRow[]).map(mapRow);

  function validate(input: { projectId: string; text: string; status: string; labels: unknown; cron: string; timeZone?: string }) {
    if (typeof input.text !== "string" || typeof input.cron !== "string") throw new ScheduledCardsError("Testo e regola cron sono obbligatori.");
    if (input.timeZone !== undefined && typeof input.timeZone !== "string") throw new ScheduledCardsError("Fuso orario non valido.");
    const text = input.text.trim();
    if (!input.projectId || !text) throw new ScheduledCardsError("Board e testo sono obbligatori.");
    if (!["backlog", "todo", "in_progress", "review"].includes(input.status)) throw new ScheduledCardsError("Colonna non valida.");
    const labels = normalizeLabels(Array.isArray(input.labels) ? input.labels.filter(isTaskLabel) : []);
    const timeZone = input.timeZone?.trim() || "Europe/Rome";
    const next = nextOccurrence(input.cron, timeZone, now());
    return { text, status: input.status as ScheduledStatus, labels, timeZone, next };
  }

  function create(input: { projectId: string; text: string; status: string; labels: unknown; cron: string; timeZone?: string }): ScheduledCard {
    const value = validate(input); const id = crypto.randomUUID(); const stamp = now().toISOString();
    db.prepare(`INSERT INTO scheduled_cards (id, project_id, text, status, labels_json, cron, time_zone, enabled, next_run_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
      .run(id, input.projectId, value.text, value.status, JSON.stringify(value.labels), input.cron.trim(), value.timeZone, value.next.toISOString(), stamp, stamp);
    return mapRow(read(id)!);
  }

  function update(id: string, projectId: string, input: { text: string; status: string; labels: unknown; cron: string; timeZone?: string; enabled?: boolean }): ScheduledCard {
    const current = read(id);
    if (!current || current.project_id !== projectId || current.deleted_at) throw new ScheduledCardsError("Ricorrenza non trovata.", 404);
    const value = validate({ ...input, projectId }); const stamp = now().toISOString();
    db.prepare(`UPDATE scheduled_cards SET text=?, status=?, labels_json=?, cron=?, time_zone=?, enabled=?, next_run_at=?, updated_at=? WHERE id=? AND project_id=?`)
      .run(value.text, value.status, JSON.stringify(value.labels), input.cron.trim(), value.timeZone,
        input.enabled === false ? 0 : 1, value.next.toISOString(), stamp, id, projectId);
    return mapRow(read(id)!);
  }

  function setEnabled(id: string, projectId: string, enabled: boolean): ScheduledCard {
    const current = read(id);
    if (!current || current.project_id !== projectId || current.deleted_at) throw new ScheduledCardsError("Ricorrenza non trovata.", 404);
    const next = enabled ? nextOccurrence(current.cron, current.time_zone, now()) : new Date(current.next_run_at);
    db.prepare("UPDATE scheduled_cards SET enabled=?, next_run_at=?, updated_at=? WHERE id=? AND project_id=?")
      .run(enabled ? 1 : 0, next.toISOString(), now().toISOString(), id, projectId);
    return mapRow(read(id)!);
  }

  function remove(id: string, projectId: string): void {
    db.prepare("UPDATE scheduled_cards SET enabled=0, deleted_at=?, updated_at=? WHERE id=? AND project_id=? AND deleted_at IS NULL")
      .run(now().toISOString(), now().toISOString(), id, projectId);
  }

  function tick(): { created: string[]; skipped: string[] } {
    const instant = now(); const created: string[] = []; const skipped: string[] = [];
    const due = db.query("SELECT * FROM scheduled_cards WHERE enabled=1 AND deleted_at IS NULL AND next_run_at<=? ORDER BY next_run_at, id").all(instant.toISOString()) as ScheduledRow[];
    for (const card of due) {
      const occurrence = occurrenceKey(new Date(card.next_run_at), card.time_zone);
      let taskId: string | null = null; let reason: string | null = null; let outcome: "created" | "skipped" = "created";
      db.transaction(() => {
        const current = read(card.id);
        if (!current || current.enabled !== 1 || current.deleted_at || current.next_run_at > instant.toISOString()) return;
        const repeatedWallTime = current.last_occurrence_key === occurrence;
        const open = db.query(`SELECT i.task_id FROM scheduled_card_instances i JOIN tasks t ON t.id=i.task_id
          WHERE i.scheduled_card_id=? AND t.status!='done' AND t.archived=0 ORDER BY i.created_at DESC LIMIT 1`).get(card.id) as { task_id: string } | null;
        if (repeatedWallTime) { outcome = "skipped"; reason = "Occorrenza già gestita per questo orario locale."; }
        else if (open) { outcome = "skipped"; reason = "La card precedente è ancora aperta."; }
        else {
          const task = tasks.create({ projectId: card.project_id, text: card.text, status: card.status, description: null, createdBy: "cron:scheduled-card" });
          taskId = task.id;
          const labels = normalizeLabels(JSON.parse(card.labels_json) as unknown[]);
          const addLabel = db.prepare("INSERT INTO task_labels (task_id, label, source, created_at) VALUES (?, ?, 'human', ?)");
          for (const label of labels) addLabel.run(task.id, label, instant.toISOString());
          db.prepare("INSERT INTO scheduled_card_instances (id, scheduled_card_id, task_id, occurrence_key, created_at) VALUES (?, ?, ?, ?, ?)")
            .run(crypto.randomUUID(), card.id, task.id, occurrence, instant.toISOString());
        }
        const next = nextOccurrence(card.cron, card.time_zone, instant);
        db.prepare(`UPDATE scheduled_cards SET next_run_at=?, last_run_at=?, last_result=?, last_reason=?, last_occurrence_key=?, updated_at=? WHERE id=?`)
          .run(next.toISOString(), instant.toISOString(), outcome, reason, occurrence, instant.toISOString(), card.id);
      })();
      if (taskId) created.push(taskId);
      else if (reason) skipped.push(card.id);
    }
    return { created, skipped };
  }

  return { create, update, setEnabled, remove, list, tick } satisfies ScheduledCardsService;
}
