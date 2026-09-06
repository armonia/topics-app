/**
 * Le due migration che rendono possibile la corsa su un secondo nodo:
 * `20260906115130-task-machine-id.sql` e `20260906115131-machine-base-url.sql`.
 *
 * ── Perche' un test su due ADD COLUMN ───────────────────────────────────────
 * Perche' quello che conta non e' la colonna, e' cosa succede alle righe che
 * c'erano gia'. Ogni card che esiste oggi deve continuare a voler dire «qui»:
 * se l'aggiunta arrivasse con un default diverso da NULL, l'installazione
 * intera si troverebbe le card puntate a una macchina, e sarebbe un guasto
 * silenzioso — nessun errore, solo card che non partono piu'.
 *
 * E il legame deve SCIOGLIERSI, non spezzarsi: cancellare una macchina porta
 * la card a NULL (cioe' locale), mai a un id che non esiste piu'. E' lo stesso
 * degrado gentile della 021 sui discorsi.
 *
 * Il test esegue i FILE delle migration, non una loro copia.
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

/** Lo scheletro minimo che le due migration presuppongono. */
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
