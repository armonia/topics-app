/**
 * Board recurrences: the tick at the right time, the skip while the previous card is open, one
 * catch-up after downtime, one card per local occurrence across DST.
 *
 * @covers KANBAN-95
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createScheduledCardsService } from "./cards-service";
import { createScheduleEngine } from "./engine";
import { createCardAction } from "./card-action";
import { createTaskService } from "../services/tasks";
import { freshDb, PID } from "../services/tasks-test-db";

describe("card a calendario", () => {
  let db: Database;
  let current: Date;
  let scheduled: ReturnType<typeof createScheduledCardsService>;
  let engine: ReturnType<typeof createScheduleEngine>;
  const wire = () => {
    const tasks = createTaskService(db, { now: () => current.toISOString() });
    scheduled = createScheduledCardsService(db, () => current);
    engine = createScheduleEngine(db, { executors: { card: createCardAction(db, tasks) }, now: () => current });
  };
  beforeEach(() => {
    db = freshDb();
    for (const file of ["20261014225051-scheduled-cards.sql", "20261121105631-scheduled-jobs.sql", "20261126180000-scheduled-delivery-guards.sql"]) {
      db.run(readFileSync(join(import.meta.dir, "../db/migrations", file), "utf8"));
    }
    current = new Date("2026-10-19T06:00:00.000Z");
    wire();
  });

  const monday = (overrides: Partial<Parameters<typeof scheduled.create>[0]> = {}) => scheduled.create({
    projectId: PID, text: "Controlla la board", status: "backlog", labels: ["feature"], cron: "0 9 * * 1", timeZone: "Europe/Rome", ...overrides,
  });
  const tasks = () => db.query("SELECT * FROM tasks ORDER BY created_at, id").all() as Array<{ id: string; status: string; archived: number }>;

  test("crea al tick del lunedì alle 9, non prima", () => {
    monday();
    expect(engine.tick().created).toHaveLength(0);
    current = new Date("2026-10-19T07:00:00.000Z");
    const result = engine.tick();
    expect(result.created).toHaveLength(1);
    expect(tasks()[0]?.status).toBe("backlog");
    expect(db.query("SELECT label FROM task_labels WHERE task_id=?").get(tasks()[0]?.id)).toEqual({ label: "feature" });
    expect(scheduled.list(PID)[0]?.lastResult).toBe("created");
  });

  test("salta la successiva se la precedente è aperta e salva il motivo", () => {
    monday();
    current = new Date("2026-10-19T07:00:00.000Z");
    engine.tick();
    current = new Date("2026-10-26T08:00:00.000Z");
    expect(engine.tick().created).toHaveLength(0);
    expect(tasks()).toHaveLength(1);
    expect(scheduled.list(PID)[0]?.lastResult).toBe("skipped");
    expect(scheduled.list(PID)[0]?.lastReason).toContain("ancora aperta");
  });

  test("dopo tre settimane recupera una sola card e il riavvio non la duplica", () => {
    monday();
    current = new Date("2026-11-09T08:00:00.000Z");
    expect(engine.tick().created).toHaveLength(1);
    wire();
    expect(engine.tick().created).toHaveLength(0);
    expect(tasks()).toHaveLength(1);
  });

  test("l'ora ripetuta d'autunno produce al massimo una card per data locale", () => {
    current = new Date("2026-10-24T12:00:00.000Z");
    scheduled.create({ projectId: PID, text: "DST autunno", status: "backlog", labels: [], cron: "30 2 * * *", timeZone: "Europe/Rome" });
    current = new Date("2026-10-25T00:30:00.000Z");
    expect(engine.tick().created).toHaveLength(1);
    current = new Date("2026-10-25T01:30:00.000Z");
    expect(engine.tick().created).toHaveLength(0);
    expect(tasks()).toHaveLength(1);
    expect(db.query("SELECT COUNT(*) AS n FROM scheduled_job_runs").get()).toEqual({ n: 1 });
  });

  test("l'ora inesistente in primavera viene saltata fino al prossimo giorno valido", () => {
    current = new Date("2026-03-28T12:00:00.000Z");
    scheduled.create({ projectId: PID, text: "DST primavera", status: "backlog", labels: [], cron: "30 2 * * *", timeZone: "Europe/Rome" });
    const next = scheduled.list(PID)[0]?.nextRunAt;
    expect(next).toBe("2026-03-30T00:30:00.000Z");
    current = new Date("2026-03-29T12:00:00.000Z");
    expect(engine.tick().created).toHaveLength(0);
  });

  test("rifiuta una data cron impossibile senza scandire ogni minuto", () => {
    expect(() => monday({ cron: "0 0 30 2 *" })).toThrow("The rule has no run in the next eight years.");
  });

  test("eliminare la ricorrenza la ferma e conserva il riferimento delle card già nate", () => {
    const card = monday();
    current = new Date("2026-10-19T07:00:00.000Z");
    const taskId = engine.tick().created[0]!;
    scheduled.remove(card.id, PID);
    expect(scheduled.list(PID)).toHaveLength(0);
    expect(db.query("SELECT job_id FROM scheduled_job_runs WHERE task_id=?").get(taskId)).toEqual({ job_id: card.id });
    current = new Date("2026-10-26T08:00:00.000Z");
    expect(engine.tick().created).toHaveLength(0);
  });
});

describe("last result of a recurrence (review finding)", () => {
  test("a run that never created a card is not shown as created", () => {
    const db = freshDb();
    for (const file of ["20261014225051-scheduled-cards.sql", "20261121105631-scheduled-jobs.sql", "20261126180000-scheduled-delivery-guards.sql"]) db.run(readFileSync(join(import.meta.dir, "../db/migrations", file), "utf8"));
    const service = createScheduledCardsService(db, () => new Date("2026-10-19T06:00:00.000Z"));
    const card = service.create({ projectId: PID, text: "x", status: "backlog", labels: [], cron: "0 9 * * 1", timeZone: "UTC" });
    db.run(`INSERT INTO scheduled_job_runs (id, job_id, occurrence_key, scheduled_for, status, reason, created_at)
      VALUES ('r', '${card.id}', 'k', 'x', 'failed_to_start', 'spawn failed', '2026-10-19T09:00:00.000Z')`);
    const [view] = service.list(PID);
    expect([view?.lastResult, view?.lastReason]).toEqual(["skipped", "spawn failed"]);
  });
});
