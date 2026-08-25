/**
 * `095-message-author.sql` — l'autore sui messaggi.
 *
 * Il file si prova PRIMA che esista sotto `server/db/migrations/`: il server di
 * produzione gira con `bun --watch`, e salvare lì dentro applica il file al DB
 * VIVO — che qui è l'archivio delle conversazioni vere — nel giro di secondi.
 *
 * Questa migration TOCCA I DATI, non solo lo schema, quindi la prova che conta
 * è sul riempimento e ha tre facce:
 *   1. con UN proprietario i messaggi utente prendono lui e le risposte NO
 *      (attribuirle raddoppierebbe il conteggio dei prompt di ognuno);
 *   2. con DUE proprietari non si scrive niente: sarebbe un'invenzione che poi
 *      si legge come una misura;
 *   3. con NESSUN proprietario nemmeno: nessuna riga da cui prendere l'autore.
  * @covers SCHEMA-07
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "./helpers";

const read = (name: string) =>
  fs.readFileSync(path.join(PROJECT_ROOT, "server/db/migrations", name), "utf-8");

const MIGRATION_SQL = read("095-message-author.sql");

function dbBefore(): Database {
  const db = new Database(":memory:");
  for (const file of ["001-initial.sql", "080-devices.sql", "084-people-orgs.sql"]) {
    for (const stmt of read(file).split(/;\s*\n/)) {
      if (!/create\s+table/i.test(stmt)) continue;
      try { db.run(stmt); } catch { /* FK verso tabelle non ancora create */ }
    }
  }
  for (const t of ["messages", "people", "devices", "installation_owners"]) {
    if (!db.query("SELECT name FROM sqlite_master WHERE name = ?").get(t)) {
      throw new Error(`${t} non esiste: lo schema è cambiato, aggiorna questo test`);
    }
  }
  return db;
}

function semina(db: Database) {
  let i = 0;
  const msg = (role: string, content: string) =>
    db.run(
      "INSERT INTO messages (id, session_key, role, content, timestamp, sort_order) VALUES (?, 's1', ?, ?, '2026-01-01', ?)",
      [`m${++i}`, role, content, i],
    );
  msg("user", "ciao");
  msg("assistant", "ciao a te");
  msg("user", "fammi una cosa");
  msg("assistant", "fatta");
}

function persona(db: Database, id: string, proprietario: boolean, isDefault = 0) {
  db.run("INSERT INTO people (id, display_name, created_at, updated_at) VALUES (?, ?, 0, 0)", [id, id]);
  if (proprietario) {
    db.run("INSERT INTO installation_owners (person_id, added_at, is_default) VALUES (?, 0, ?)", [id, isDefault]);
  }
}

const autori = (db: Database) =>
  (db.query("SELECT id, role, author_person_id AS a FROM messages ORDER BY sort_order").all() as Array<
    { role: string; a: string | null }
  >);

describe("migration 095 — autore sui messaggi", () => {
  test("prima della migration le colonne non esistono", () => {
    const db = dbBefore();
    expect(() => db.query("SELECT author_person_id FROM messages").get()).toThrow();
    expect(() => db.query("SELECT author_device_id FROM messages").get()).toThrow();
    db.close();
  });

  test("un solo proprietario: i prompt sono suoi, le risposte di nessuno", () => {
    const db = dbBefore();
    semina(db);
    persona(db, "attilio", true, 1);
    db.run(MIGRATION_SQL);

    const r = autori(db);
    expect(r.filter((x) => x.role === "user").every((x) => x.a === "attilio")).toBe(true);
    expect(r.filter((x) => x.role === "assistant").every((x) => x.a === null)).toBe(true);
    // Il dispositivo non lo sa nessuno all'indietro, e resta NULL.
    const dev = db.query("SELECT COUNT(*) AS n FROM messages WHERE author_device_id IS NOT NULL").get() as { n: number };
    expect(dev.n).toBe(0);
    db.close();
  });

  test("due proprietari: NON si inventa un autore", () => {
    const db = dbBefore();
    semina(db);
    persona(db, "attilio", true, 1);
    persona(db, "mircea", true, 0);
    db.run(MIGRATION_SQL);
    expect(autori(db).every((x) => x.a === null)).toBe(true);
    db.close();
  });

  test("nessun proprietario: niente da scrivere, e la migration passa lo stesso", () => {
    const db = dbBefore();
    semina(db);
    expect(() => db.run(MIGRATION_SQL)).not.toThrow();
    expect(autori(db).every((x) => x.a === null)).toBe(true);
    db.close();
  });

  test("nient'altro si muove: contenuti, ruoli e ordine restano quelli", () => {
    const db = dbBefore();
    semina(db);
    persona(db, "attilio", true, 1);
    db.run(MIGRATION_SQL);
    const righe = db.query("SELECT content, role FROM messages ORDER BY sort_order").all() as Array<
      { content: string; role: string }
    >;
    expect(righe.map((r) => r.content)).toEqual(["ciao", "ciao a te", "fammi una cosa", "fatta"]);
    expect(righe.map((r) => r.role)).toEqual(["user", "assistant", "user", "assistant"]);
    db.close();
  });

  test("un messaggio nuovo nasce senza autore finché qualcuno non lo scrive", () => {
    const db = dbBefore();
    persona(db, "attilio", true, 1);
    db.run(MIGRATION_SQL);
    db.run(
      "INSERT INTO messages (id, session_key, role, content, timestamp, sort_order) VALUES ('nuovo', 's1', 'user', 'x', '2026-01-01', 9)",
    );
    const r = db.query("SELECT author_person_id AS a FROM messages WHERE id = 'nuovo'").get() as { a: string | null };
    expect(r.a).toBeNull();
    db.close();
  });
});
