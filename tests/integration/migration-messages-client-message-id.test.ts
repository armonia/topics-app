/**
 * `20261003202540-messages-client-message-id.sql`: the send's key on the
 * person's row, one row per key per session.
 *
 * What the route relies on, proven on the FILE itself against a synthetic
 * database that already holds rows: the rows written before it keep no key
 * (no backfill, the keys were never stored), a second row with the same key in
 * the same session is refused by SQLite itself (the backstop for two requests
 * racing), and nothing else is constrained: rows without a key, and the same
 * key in another session, are written as before.
 * @covers SCHEMA-07
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "./helpers";

const MIGRATION_SQL = fs.readFileSync(
  path.join(PROJECT_ROOT, "server/db/migrations/20261003202540-messages-client-message-id.sql"),
  "utf-8",
);

function dbWithHistory(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    session_key TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    timestamp TEXT,
    sort_order INTEGER
  )`);
  const ins = db.prepare("INSERT INTO messages (id, session_key, role, content, timestamp, sort_order) VALUES (?, 's1', ?, ?, '2026-10-01', ?)");
  ins.run("old-1", "user", "deploy it", 0);
  ins.run("old-2", "assistant", "Deployed.", 1);
  ins.run("old-3", "user", "deploy it", 2);
  return db;
}

const keyed = (db: Database, id: string, sessionKey: string, key: string | null) =>
  db.run(
    "INSERT INTO messages (id, session_key, role, content, timestamp, sort_order, client_message_id) VALUES (?, ?, 'user', 'deploy it', '2026-10-03', 9, ?)",
    [id, sessionKey, key],
  );

describe("migration 20261003202540: the send's key on the person's row", () => {
  test("before it, the column does not exist", () => {
    const db = dbWithHistory();
    expect(() => db.query("SELECT client_message_id FROM messages").get()).toThrow();
    db.close();
  });

  test("the rows already written keep no key: nothing is invented for them", () => {
    const db = dbWithHistory();
    db.run(MIGRATION_SQL);
    const rows = db.query("SELECT id, client_message_id AS k FROM messages ORDER BY sort_order").all();
    expect(rows).toEqual([
      { id: "old-1", k: null },
      { id: "old-2", k: null },
      { id: "old-3", k: null },
    ]);
    db.close();
  });

  test("a second row with the same key in the same session is refused by SQLite", () => {
    const db = dbWithHistory();
    db.run(MIGRATION_SQL);
    keyed(db, "new-1", "s1", "key-a");
    expect(() => keyed(db, "new-2", "s1", "key-a")).toThrow(/UNIQUE constraint failed: messages\.session_key, messages\.client_message_id/);
    expect(db.query("SELECT COUNT(*) AS n FROM messages WHERE client_message_id = 'key-a'").get()).toEqual({ n: 1 });
    db.close();
  });

  test("only keyed rows of one session are constrained: no key, or another session, writes as before", () => {
    const db = dbWithHistory();
    db.run(MIGRATION_SQL);
    keyed(db, "new-1", "s1", null);
    keyed(db, "new-2", "s1", null);
    keyed(db, "new-3", "s1", "key-a");
    keyed(db, "new-4", "s2", "key-a");
    expect(db.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 7 });
    db.close();
  });

  test("the route's lookup by session and key uses the index", () => {
    const db = dbWithHistory();
    db.run(MIGRATION_SQL);
    const plan = (db.query("EXPLAIN QUERY PLAN SELECT id FROM messages WHERE session_key = ? AND client_message_id = ?").all("s1", "k") as Array<{ detail: string }>)
      .map((r) => r.detail).join(" | ");
    expect(plan).toContain("idx_messages_session_client_message_id");
    db.close();
  });
});
