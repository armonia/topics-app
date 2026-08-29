/**
 * `20260829173000-notifiche-il-cui-soggetto-e-andato-avanti.sql` — la
 * campanella smette di contare cose gia' successe.
 *
 * IL DIFETTO, misurato su `data/topics.db` il 29/08/2026: 400 notifiche non
 * viste contro una decina di segnali vivi nel resto della app. Non erano due
 * letture dello stesso insieme, erano due insiemi — il chrome conta LAVORO
 * PENDENTE, la campanella conta EVENTI in un registro a 30 giorni — e nessuno
 * spegneva gli eventi. Delle 400: 74 `task-review` di card gia' approvate, 1
 * `task-parked`, 325 `session` di terminali finiti.
 *
 * Il codice nuovo non basta: vale per le righe FUTURE, e queste sono a schermo
 * adesso. Il test gira il FILE della migration, non una sua copia riscritta
 * qui, e su dati che riproducono i tre casi veri piu' i tre che NON deve
 * toccare.
 *
 * @covers NOTIF-SEEN-01
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "./helpers";

const SQL = fs.readFileSync(
  path.join(PROJECT_ROOT, "server/db/migrations/20260829173000-notifiche-il-cui-soggetto-e-andato-avanti.sql"),
  "utf-8",
);

const ORA = new Date().toISOString();
const IERI = new Date(Date.now() - 26 * 3600_000).toISOString();

function mondo(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT, dispatch_state TEXT)`);
  db.run(`CREATE TABLE notification_log (
    id TEXT PRIMARY KEY, created_at TEXT NOT NULL, kind TEXT NOT NULL,
    title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
    target_kind TEXT, target_id TEXT, target_url TEXT,
    source TEXT NOT NULL DEFAULT 'banner', dedupe_key TEXT NOT NULL,
    group_key TEXT, seen_at TEXT)`);

  db.run(`INSERT INTO tasks VALUES ('t-done','done',NULL), ('t-review','review',NULL),
          ('t-parked','todo','needs_input')`);

  const n = (id: string, kind: string, tk: string | null, ti: string | null, created: string, gk: string | null) =>
    db.run(
      `INSERT INTO notification_log (id, created_at, kind, title, target_kind, target_id, dedupe_key, group_key)
       VALUES (?,?,?,?,?,?,?,?)`,
      [id, created, kind, "t", tk, ti, `${kind}:${ti ?? id}`, gk],
    );

  // DA SPEGNERE
  n("a", "task-review", "task", "t-done", IERI, "task:t-done");
  n("b", "task-parked", "task", "t-done", IERI, "task:t-done");
  n("c", "session", null, null, IERI, null);
  // DA NON TOCCARE
  n("d", "task-review", "task", "t-review", IERI, "task:t-review");   // la card e' ancora in review
  n("e", "task-parked", "task", "t-parked", IERI, "task:t-parked");   // ancora in attesa
  n("f", "session", null, null, ORA, null);                            // finito ADESSO
  n("g", "chat-message", "topic", "top-1", IERI, "topic:top-1");      // un altro genere
  return db;
}

const spente = (db: Database) =>
  new Set(
    (db.query("SELECT id FROM notification_log WHERE seen_at IS NOT NULL").all() as { id: string }[]).map((r) => r.id),
  );

describe("le notifiche il cui soggetto e' andato avanti", () => {
  test("prima della migration NESSUNA e' vista: il rosso c'e'", () => {
    const db = mondo();
    expect(spente(db).size).toBe(0);
    db.close();
  });

  test("spegne l'avviso di una card che non e' piu' in quello stato", () => {
    const db = mondo();
    db.run(SQL);
    const s = spente(db);
    expect(s.has("a")).toBe(true);
    expect(s.has("b")).toBe(true);
    db.close();
  });

  test("spegne il terminale finito piu' di un'ora fa", () => {
    const db = mondo();
    db.run(SQL);
    expect(spente(db).has("c")).toBe(true);
    db.close();
  });

  test("NON tocca cio' che e' ancora da guardare", () => {
    // E' la meta' che conta: una migration che spegne troppo ruba un avviso, e
    // chi lo perde non ha modo di sapere che c'era.
    const db = mondo();
    db.run(SQL);
    const s = spente(db);
    expect(s.has("d"), "una card ancora in review").toBe(false);
    expect(s.has("e"), "un task ancora in attesa di risposta").toBe(false);
    expect(s.has("f"), "un terminale finito adesso").toBe(false);
    expect(s.has("g"), "un genere che questa migration non nomina").toBe(false);
    db.close();
  });

  test("rigirarla non cambia niente", () => {
    // Le migration si riapplicano quando qualcuno ricostruisce un database da
    // zero: il secondo giro deve essere un no-op, non una seconda mano di
    // vernice su righe gia' spente.
    const db = mondo();
    db.run(SQL);
    const primo = spente(db);
    db.run(SQL);
    expect(spente(db)).toEqual(primo);
    db.close();
  });
});
