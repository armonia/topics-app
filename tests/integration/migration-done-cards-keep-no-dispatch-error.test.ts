/**
 * `20260904101008-done-cards-keep-no-dispatch-error.sql` - a closed card does
 * not wear a failure.
 *
 * `dispatch_error` says why the LAST turn did not get there ("the turn ended
 * without reaching review after 2 attempts"). Nothing cleared it on the way to
 * done, and the chip that reads it never looked at the status: on the live DB
 * 44 non-archived done cards carried a rose 'stopped' badge, several of them
 * for a turn that ended weeks before a person finished the work by hand.
 *
 * The migration is the THIRD of three pieces, and the only one that can touch
 * rows already written: the service clears the column at the transition to
 * done, the client guards the chip on the status, and this cleans up what both
 * arrived too late for.
 *
 * The file is read from disk and run against a synthetic in-memory DB: the dev
 * server runs with `bun --watch`, so a test that pointed at the real database
 * would rewrite the live board's cards.
 *
 * @covers SCHEMA-07
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "./helpers";

const read = (name: string) =>
  fs.readFileSync(path.join(PROJECT_ROOT, "server/db/migrations", name), "utf-8");

const MIGRATION_SQL = read("20260904101008-done-cards-keep-no-dispatch-error.sql");

function dbBefore(): Database {
  const db = new Database(":memory:");
  for (const stmt of read("001-initial.sql").split(/;\s*\n/)) {
    if (!/create\s+table/i.test(stmt)) continue;
    try { db.run(stmt); } catch { /* FKs to tables not created yet: irrelevant here */ }
  }
  if (!db.query("SELECT name FROM sqlite_master WHERE name = 'tasks'").get()) {
    throw new Error("tasks was not created: the schema moved, update this test");
  }
  // The column is not born with the table: `031-task-dispatch.sql` adds it.
  // Only the two statements this migration touches are replayed, rather than
  // the whole chain, so the bench stays readable and independent of the ninety
  // migrations in between.
  db.run("ALTER TABLE tasks ADD COLUMN dispatch_error TEXT");
  return db;
}

function task(db: Database, id: string, status: string, error: string | null) {
  db.run(
    "INSERT INTO tasks (id, project_id, text, status, dispatch_error, created_at, updated_at) VALUES (?, 'p1', ?, ?, ?, 'x', 'x')",
    [id, `card ${id}`, status, error],
  );
}

const errorOf = (db: Database, id: string) =>
  (db.query("SELECT dispatch_error FROM tasks WHERE id = ?").get(id) as any).dispatch_error;

describe("done cards keep no dispatch_error", () => {
  test("the badge on a closed card goes, and only there", () => {
    const db = dbBefore();
    const stopped = "Il turno è terminato senza arrivare a review dopo 2 tentativi.";   // allow-italian: the exact sentence the rows carry
    task(db, "done-with-error", "done", stopped);
    task(db, "done-clean", "done", null);
    // The three columns where the SAME sentence is still true: the card has not
    // finished, and the reason it stopped is what the reader has to see.
    task(db, "todo-with-error", "todo", stopped);
    task(db, "backlog-with-error", "backlog", stopped);
    task(db, "review-with-error", "review", stopped);

    db.run(MIGRATION_SQL);

    expect(errorOf(db, "done-with-error")).toBeNull();
    expect(errorOf(db, "done-clean")).toBeNull();
    expect(errorOf(db, "todo-with-error")).toBe(stopped);
    expect(errorOf(db, "backlog-with-error")).toBe(stopped);
    expect(errorOf(db, "review-with-error")).toBe(stopped);
  });

  test("no done row survives with a reason: the invariant, not the single case", () => {
    const db = dbBefore();
    for (let i = 0; i < 44; i++) task(db, `d${i}`, "done", `turno interrotto ${i}`);   // allow-italian: sample rows in the wording the DB carries
    db.run(MIGRATION_SQL);
    const left = db.query(
      "SELECT COUNT(*) AS n FROM tasks WHERE status = 'done' AND dispatch_error IS NOT NULL",
    ).get() as { n: number };
    expect(left.n).toBe(0);
  });

  test("running it twice changes nothing: a migration is not a one-shot", () => {
    const db = dbBefore();
    task(db, "d1", "done", "boom");
    db.run(MIGRATION_SQL);
    db.run(MIGRATION_SQL);
    expect(errorOf(db, "d1")).toBeNull();
  });
});
