/**
 * `20260829173000-notifiche-il-cui-soggetto-e-andato-avanti.sql`  allow-italian: the migration's own filename
 * - the bell
 * stops counting things that already happened.
 *
 * THE DEFECT, measured on `data/topics.db` on 2026-08-29: 400 unseen
 * notifications against about ten live signals in the rest of the app. Those
 * were not two readings of one set, they were two sets - the chrome counts
 * PENDING WORK, the bell counts EVENTS in a 30-day log - and nothing ever
 * cleared the events. Of the 400: 74 `task-review` for cards already approved,
 * 1 `task-parked`, 325 `session` for terminals long finished.
 *
 * New code is not enough: it applies to FUTURE rows, and these are on screen
 * now. This runs the migration FILE, not a copy rewritten here, over data that
 * reproduces the three real cases plus the four it must NOT touch.
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
const YESTERDAY = new Date(Date.now() - 26 * 3600_000).toISOString();

function world(): Database {
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

  // TO BE CLEARED
  n("a", "task-review", "task", "t-done", YESTERDAY, "task:t-done");
  n("b", "task-parked", "task", "t-done", YESTERDAY, "task:t-done");
  n("c", "session", null, null, YESTERDAY, null);
  // TO BE LEFT ALONE
  n("d", "task-review", "task", "t-review", YESTERDAY, "task:t-review");   // still in review
  n("e", "task-parked", "task", "t-parked", YESTERDAY, "task:t-parked");   // still waiting
  n("f", "session", null, null, ORA, null);                            // finished JUST NOW
  n("g", "chat-message", "topic", "top-1", YESTERDAY, "topic:top-1");      // another kind
  return db;
}

const cleared = (db: Database) =>
  new Set(
    (db.query("SELECT id FROM notification_log WHERE seen_at IS NOT NULL").all() as { id: string }[]).map((r) => r.id),
  );

describe("le notifiche il cui soggetto e' andato avanti", () => {
  test("prima della migration NESSUNA e' vista: il rosso c'e'", () => {
    const db = world();
    expect(cleared(db).size).toBe(0);
    db.close();
  });

  test("spegne l'avviso di una card che non e' piu' in quello stato", () => {
    const db = world();
    db.run(SQL);
    const s = cleared(db);
    expect(s.has("a")).toBe(true);
    expect(s.has("b")).toBe(true);
    db.close();
  });

  test("spegne il terminale finito piu' di un'ora fa", () => {
    const db = world();
    db.run(SQL);
    expect(cleared(db).has("c")).toBe(true);
    db.close();
  });

  test("NON tocca cio' che e' ancora da guardare", () => {
    // The half that matters: a migration that clears too much steals a
    // warning, and whoever loses it has no way to know it was there.
    const db = world();
    db.run(SQL);
    const s = cleared(db);
    expect(s.has("d"), "una card ancora in review").toBe(false);
    expect(s.has("e"), "un task ancora in attesa di risposta").toBe(false);
    expect(s.has("f"), "un terminale finito adesso").toBe(false);
    expect(s.has("g"), "un genere che questa migration non nomina").toBe(false);
    db.close();
  });

  test("rigirarla non cambia niente", () => {
    // Migrations re-run whenever someone rebuilds a database from scratch:
    // the second pass has to be a no-op, not a second coat of paint over rows
    // that are already cleared.
    const db = world();
    db.run(SQL);
    const first = cleared(db);
    db.run(SQL);
    expect(cleared(db)).toEqual(first);
    db.close();
  });
});
