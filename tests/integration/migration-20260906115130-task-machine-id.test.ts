/**
 * The two migrations that make a run on a second node possible:
 * `20260906115130-task-machine-id.sql` and `20260906115131-machine-base-url.sql`.
 *
 * WHY A TEST ON TWO ADD COLUMN.
 * Because what matters is not the column, it is what happens to the rows that
 * were already there. Every card that exists today has to keep meaning "here":
 * if the column arrived with anything other than NULL, the whole installation
 * would find its cards pointed at a machine, and it would be a SILENT failure,
 * no error, just cards that stop starting.
 *
 * And the link has to COME UNDONE, not break: deleting a machine takes the
 * card back to NULL, which is local, never to an id that is gone. It is the
 * same gentle degradation the 021 gives topics.
 *
 * The test runs the migration FILES, not a copy of them.
 *
 * @covers MACHINE-02
 * @covers SCHEMA-07
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DIR = resolve(import.meta.dir, "../../server/db/migrations");
const TASK_MACHINE_ID = readFileSync(resolve(DIR, "20260906115130-task-machine-id.sql"), "utf8");
const MACHINE_BASE_URL = readFileSync(resolve(DIR, "20260906115131-machine-base-url.sql"), "utf8");

/** The smallest schema the two migrations presume. */
function seed(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE machines (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      hostname TEXT NOT NULL UNIQUE
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'backlog'
    );
    INSERT INTO machines (id, name, hostname) VALUES ('m1', 'nodo', 'nodo.local');
    INSERT INTO tasks (id, text) VALUES ('t-old', 'una card che esisteva prima');
  `);
  return db;
}

function migrate(db: Database): void {
  db.exec(TASK_MACHINE_ID);
  db.exec(MACHINE_BASE_URL);
}

describe("migration task.machine_id + machines.base_url", () => {
  test("una card che esisteva prima resta LOCALE: machine_id NULL", () => {
    const db = seed();
    migrate(db);
    const row = db.query("SELECT machine_id FROM tasks WHERE id = 't-old'").get() as {
      machine_id: string | null;
    };
    expect(row.machine_id).toBeNull();
    db.close();
  });

  test("cancellare la macchina scioglie il legame, non lo spezza", () => {
    const db = seed();
    migrate(db);
    db.exec("UPDATE tasks SET machine_id = 'm1' WHERE id = 't-old'");
    db.exec("DELETE FROM machines WHERE id = 'm1'");
    const row = db.query("SELECT machine_id FROM tasks WHERE id = 't-old'").get() as {
      machine_id: string | null;
    };
    expect(row.machine_id).toBeNull();
    db.close();
  });

  test("un machine_id che non esiste e' RIFIUTATO", () => {
    const db = seed();
    migrate(db);
    expect(() => db.exec("UPDATE tasks SET machine_id = 'ghost' WHERE id = 't-old'")).toThrow();
    db.close();
  });

  test("l'indirizzo del nodo nasce ASSENTE sulla riga che c'era gia'", () => {
    const db = seed();
    migrate(db);
    const row = db.query("SELECT base_url FROM machines WHERE id = 'm1'").get() as {
      base_url: string | null;
    };
    expect(row.base_url).toBeNull();
    db.exec("UPDATE machines SET base_url = 'https://nodo.local:3333' WHERE id = 'm1'");
    const after = db.query("SELECT base_url FROM machines WHERE id = 'm1'").get() as {
      base_url: string;
    };
    expect(after.base_url).toBe("https://nodo.local:3333");
    db.close();
  });

  test("l'indice sulla colonna esiste: il dispatcher cerca per macchina", () => {
    const db = seed();
    migrate(db);
    const idx = db
      .query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_tasks_machine'")
      .get();
    expect(idx).toBeTruthy();
    db.close();
  });
});
