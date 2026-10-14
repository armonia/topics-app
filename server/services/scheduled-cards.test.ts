import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createScheduledCards } from "./scheduled-cards";
import { createTaskService } from "./tasks";
import { freshDb, PID } from "./tasks-test-db";

describe("card a calendario", () => {
  let db: Database;
  let current: Date;
  let scheduled: ReturnType<typeof createScheduledCards>;
  beforeEach(() => {
    db = freshDb();
    db.run(readFileSync(join(import.meta.dir, "../db/migrations/20261014225051-scheduled-cards.sql"), "utf8"));
    current = new Date("2026-10-19T06:00:00.000Z");
    scheduled = createScheduledCards(db, createTaskService(db, { now: () => current.toISOString() }), () => current);
  });

  const monday = (overrides: Partial<Parameters<typeof scheduled.create>[0]> = {}) => scheduled.create({
    projectId: PID, text: "Controlla la board", status: "backlog", labels: ["feature"], cron: "0 9 * * 1", timeZone: "Europe/Rome", ...overrides,
  });
  const tasks = () => db.query("SELECT * FROM tasks ORDER BY created_at, id").all() as Array<{ id: string; status: string; archived: number }>;

  test("crea al tick del lunedì alle 9, non prima", () => {
    monday();
    expect(scheduled.tick().created).toHaveLength(0);
    current = new Date("2026-10-19T07:00:00.000Z");
    const result = scheduled.tick();
    expect(result.created).toHaveLength(1);
    expect(tasks()[0]?.status).toBe("backlog");
    expect(db.query("SELECT label FROM task_labels WHERE task_id=?").get(tasks()[0]?.id)).toEqual({ label: "feature" });
    expect(scheduled.list(PID)[0]?.lastResult).toBe("created");
  });

  test("salta la successiva se la precedente è aperta e salva il motivo", () => {
    monday();
    current = new Date("2026-10-19T07:00:00.000Z");
    scheduled.tick();
    current = new Date("2026-10-26T08:00:00.000Z");
    expect(scheduled.tick().created).toHaveLength(0);
    expect(tasks()).toHaveLength(1);
    expect(scheduled.list(PID)[0]?.lastResult).toBe("skipped");
    expect(scheduled.list(PID)[0]?.lastReason).toContain("ancora aperta");
  });

  test("dopo tre settimane recupera una sola card e il riavvio non la duplica", () => {
    monday();
    current = new Date("2026-11-09T08:00:00.000Z");
    expect(scheduled.tick().created).toHaveLength(1);
    scheduled = createScheduledCards(db, createTaskService(db, { now: () => current.toISOString() }), () => current);
    expect(scheduled.tick().created).toHaveLength(0);
    expect(tasks()).toHaveLength(1);
  });

  test("l'ora ripetuta d'autunno produce al massimo una card per data locale", () => {
    current = new Date("2026-10-24T12:00:00.000Z");
    scheduled.create({ projectId: PID, text: "DST autunno", status: "backlog", labels: [], cron: "30 2 * * *", timeZone: "Europe/Rome" });
    current = new Date("2026-10-25T00:30:00.000Z");
    expect(scheduled.tick().created).toHaveLength(1);
    current = new Date("2026-10-25T01:30:00.000Z");
    expect(scheduled.tick().created).toHaveLength(0);
    expect(tasks()).toHaveLength(1);
    expect(scheduled.list(PID)[0]?.lastReason).toContain("già gestita");
  });

  test("l'ora inesistente in primavera viene saltata fino al prossimo giorno valido", () => {
    current = new Date("2026-03-28T12:00:00.000Z");
    scheduled.create({ projectId: PID, text: "DST primavera", status: "backlog", labels: [], cron: "30 2 * * *", timeZone: "Europe/Rome" });
    const next = scheduled.list(PID)[0]?.nextRunAt;
    expect(next).toBe("2026-03-30T00:30:00.000Z");
    current = new Date("2026-03-29T12:00:00.000Z");
    expect(scheduled.tick().created).toHaveLength(0);
  });

  test("rifiuta una data cron impossibile senza scandire ogni minuto", () => {
    expect(() => monday({ cron: "0 0 30 2 *" })).toThrow("La regola non ha esecuzioni nei prossimi otto anni.");
  });

  test("eliminare la ricorrenza la ferma e conserva il riferimento delle card già nate", () => {
    const card = monday();
    current = new Date("2026-10-19T07:00:00.000Z");
    const taskId = scheduled.tick().created[0]!;
    scheduled.remove(card.id, PID);
    expect(scheduled.list(PID)).toHaveLength(0);
    expect(db.query("SELECT scheduled_card_id FROM scheduled_card_instances WHERE task_id=?").get(taskId)).toEqual({ scheduled_card_id: card.id });
    current = new Date("2026-10-26T08:00:00.000Z");
    expect(scheduled.tick().created).toHaveLength(0);
  });
});
