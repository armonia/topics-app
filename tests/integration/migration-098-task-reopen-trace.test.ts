/**
 * `098-task-reopen-trace.sql` — chi ha chiuso la card, e la traccia di quando è
 * uscita da `done`.
 *
 * Il file si prova PRIMA che esista sotto `server/db/migrations/`: il server di
 * produzione gira con `bun --watch`, e salvare lì dentro applica il file al DB
 * VIVO — le card vere di Attilio — nel giro di secondi. Per questo il test legge
 * il FILE e lo esegue su un DB sintetico in memoria.
 *
 * Le quattro colonne sono nullable e senza default, quindi l'ALTER non può
 * rompere nulla: ciò che questa migration può sbagliare in silenzio è il
 * RIEMPIMENTO, ed è dove guarda il test.
 *   1. le colonne esistono e le righe già `done` senza prova restano NULL
 *      («non si sa» è una risposta, 'human' inventato sarebbe una bugia che poi
 *      il cancello legge come una decisione umana mai presa);
 *   2. una card `done` con un'approvazione di review APPROVATA prende
 *      `done_actor = 'human'` — l'unica prova certa che lo storico contenga;
 *   3. un'approvazione `pending`/`rejected`/`expired` NON è una chiusura umana,
 *      e nemmeno un'approvazione di tipo diverso (`completion`);
 *   4. una card NON `done` non viene toccata, anche se porta un'approvazione
 *      approvata nello storico (era già stata riaperta: `done_actor` deve
 *      restare NULL, altrimenti il cancello la murerebbe a posteriori).
  * @covers SCHEMA-07
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "./helpers";

const read = (name: string) =>
  fs.readFileSync(path.join(PROJECT_ROOT, "server/db/migrations", name), "utf-8");

const MIGRATION_SQL = read("098-task-reopen-trace.sql");

/** Lo schema com'era: `tasks` e `approvals` nascono entrambe nella 001. */
function dbBefore(): Database {
  const db = new Database(":memory:");
  for (const stmt of read("001-initial.sql").split(/;\s*\n/)) {
    if (!/create\s+table/i.test(stmt)) continue;
    try { db.run(stmt); } catch { /* FK verso tabelle non ancora create: irrilevanti qui */ }
  }
  for (const t of ["tasks", "approvals"]) {
    if (!db.query("SELECT name FROM sqlite_master WHERE name = ?").get(t)) {
      throw new Error(`${t} non è stata creata: lo schema è cambiato, aggiorna questo test`);
    }
  }
  return db;
}

function task(db: Database, id: string, status: string) {
  db.run(
    "INSERT INTO tasks (id, project_id, text, status, created_at, updated_at) VALUES (?, 'p1', ?, ?, 'x', 'x')",
    [id, `card ${id}`, status],
  );
}

function approval(db: Database, taskId: string, status: string, type = "review") {
  db.run(
    "INSERT INTO approvals (id, task_id, requested_by, approval_type, status, created_at) VALUES (?, ?, 'agent', ?, ?, 'x')",
    [`a-${taskId}-${status}-${type}`, taskId, type, status],
  );
}

function apply(db: Database) {
  db.run(MIGRATION_SQL);
}

const actorOf = (db: Database, id: string) =>
  (db.query("SELECT done_actor FROM tasks WHERE id = ?").get(id) as any).done_actor;

describe("098-task-reopen-trace", () => {
  test("le quattro colonne esistono e sono nullable: nessuna riga esistente si rompe", () => {
    const db = dbBefore();
    task(db, "t1", "done");
    task(db, "t2", "todo");
    apply(db);

    const cols = (db.query("PRAGMA table_info(tasks)").all() as any[]).map((c) => c.name);
    for (const c of ["done_actor", "reopened_at", "reopened_by", "reopened_actor"]) {
      expect(cols).toContain(c);
    }
    // Nessuna traccia di riapertura inventata sullo storico: la traccia nasce da
    // un'uscita da `done` osservata, non da una deduzione.
    const row = db.query("SELECT reopened_at, reopened_by, reopened_actor FROM tasks WHERE id = 't1'").get() as any;
    expect(row.reopened_at).toBeNull();
    expect(row.reopened_by).toBeNull();
    expect(row.reopened_actor).toBeNull();
    expect(db.query("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 2 } as any);
  });

  test("done senza prova = NULL: «non si sa» resta «non si sa»", () => {
    const db = dbBefore();
    task(db, "senza-prova", "done");
    apply(db);
    expect(actorOf(db, "senza-prova")).toBeNull();
  });

  test("done + approvazione di review APPROVATA = chiusura umana", () => {
    const db = dbBefore();
    task(db, "approvata", "done");
    approval(db, "approvata", "approved");
    apply(db);
    expect(actorOf(db, "approvata")).toBe("human");
  });

  test("un'approvazione non approvata (o di altro tipo) non è una chiusura umana", () => {
    const db = dbBefore();
    for (const s of ["pending", "rejected", "expired"]) {
      task(db, `rev-${s}`, "done");
      approval(db, `rev-${s}`, s);
    }
    // `completion` è un altro flusso: non è il bottone «approva» della review.
    task(db, "altro-tipo", "done");
    approval(db, "altro-tipo", "approved", "completion");
    apply(db);

    for (const s of ["pending", "rejected", "expired"]) expect(actorOf(db, `rev-${s}`)).toBeNull();
    expect(actorOf(db, "altro-tipo")).toBeNull();
  });

  test("una card NON done non viene toccata, nemmeno se ha un'approvazione nello storico", () => {
    const db = dbBefore();
    // Il caso vero dell'11/08: approvata e poi RIAPERTA. Scrivere 'human' qui
    // significherebbe murarla a posteriori — l'agent che ci lavora prenderebbe
    // 409 su una chiusura che non esiste più.
    task(db, "riaperta", "in_progress");
    approval(db, "riaperta", "approved");
    apply(db);
    expect(actorOf(db, "riaperta")).toBeNull();
  });
});
