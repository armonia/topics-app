/**
 * The migration that carries the board recurrences into the engine's tables
 * (R1): same ids, same next occurrence, the cards already born kept as runs.
 *
 * @covers SCHED-01
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { freshDb, PID } from "../services/tasks-test-db";

const dir = join(import.meta.dir, "../db/migrations");

describe("scheduled_cards to scheduled_jobs", () => {
  test("a synthetic DB keeps the same jobs and the same next occurrence", () => {
    const db: Database = freshDb();
    db.run(readFileSync(join(dir, "20261014225051-scheduled-cards.sql"), "utf8"));
    db.run(`INSERT INTO tasks (id, project_id, text, status, created_at, updated_at) VALUES ('t1', '${PID}', 'old card', 'backlog', 'x', 'x')`);
    db.run(`INSERT INTO scheduled_cards (id, project_id, text, status, labels_json, cron, time_zone, enabled, next_run_at, created_at, updated_at, deleted_at)
      VALUES ('a', '${PID}', 'Check the deploy', 'todo', '["feature"]', '0 9 * * 1', 'Europe/Rome', 1, '2026-10-26T08:00:00.000Z', 'c', 'u', NULL),
             ('b', '${PID}', 'Paused one', 'backlog', '[]', '*/5 * * * *', 'UTC', 0, '2026-10-20T00:00:00.000Z', 'c', 'u', 'gone')`);
    db.run(`INSERT INTO scheduled_card_instances (id, scheduled_card_id, task_id, occurrence_key, created_at) VALUES ('i1', 'a', 't1', '2026-10-19T09:00', '2026-10-19T07:00:00.000Z')`);

    db.run(readFileSync(join(dir, "20261121105631-scheduled-jobs.sql"), "utf8"));

    const jobs = db.query("SELECT id, project_id, enabled, next_run_at, deleted_at, schedule_json, action_json FROM scheduled_jobs ORDER BY id").all() as Array<Record<string, unknown>>;
    expect(jobs.map(j => [j.id, j.enabled, j.next_run_at, j.deleted_at])).toEqual([
      ["a", 1, "2026-10-26T08:00:00.000Z", null],
      ["b", 0, "2026-10-20T00:00:00.000Z", "gone"],
    ]);
    expect(JSON.parse(jobs[0].schedule_json as string)).toEqual({ kind: "cron", expr: "0 9 * * 1", tz: "Europe/Rome" });
    expect(JSON.parse(jobs[0].action_json as string)).toEqual({ kind: "card", text: "Check the deploy", status: "todo", labels: ["feature"] });
    expect(db.query("SELECT job_id, task_id, status FROM scheduled_job_runs").all()).toEqual([{ job_id: "a", task_id: "t1", status: "ok" }]);
    // running it twice changes nothing
    db.run(readFileSync(join(dir, "20261121105631-scheduled-jobs.sql"), "utf8"));
    expect((db.query("SELECT COUNT(*) AS n FROM scheduled_jobs").get() as { n: number }).n).toBe(2);
  });
});
