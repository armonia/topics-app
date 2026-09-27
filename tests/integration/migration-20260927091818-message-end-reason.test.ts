/**
 * `20260927091818-message-end-reason.sql`: how an assistant row was closed.
 * @covers CHAT-INT-01
 *
 * The file itself, run against a synthetic database with the `messages` table
 * of 001 and rows already in it: the column appears, every row written before
 * it reads NULL (the readers keep the `latency_ms` rule for those, so history
 * reads as it did), nothing else moves, and the writers' values go in.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "./helpers";

const read = (name: string) => fs.readFileSync(path.join(PROJECT_ROOT, "server/db/migrations", name), "utf-8");
const MIGRATION_SQL = read("20260927091818-message-end-reason.sql");

function dbBefore(): Database {
  const db = new Database(":memory:");
  for (const statement of read("001-initial.sql").split(/;\s*\n/)) {
    if (!/create\s+table\s+(if\s+not\s+exists\s+)?messages\b/i.test(statement)) continue;
    db.run(statement);
  }
  db.run("ALTER TABLE messages ADD COLUMN latency_ms INTEGER");
  const row = db.prepare("INSERT INTO messages (id, session_key, role, content, partial, timestamp, sort_order, latency_ms) VALUES (?, 's1', ?, ?, ?, '2026-09-25', ?, ?)");
  row.run("u1", "user", "ping", 0, 0, null);
  row.run("a1", "assistant", "risposta intera", 0, 1, 812);
  row.run("a2", "assistant", "mezza frase", 0, 2, null);
  row.run("a3", "assistant", "in corso", 1, 3, null);
  return db;
}

// `prepare`, not the cached `query`: a statement cached before the ALTER keeps the old columns.
const all = (db: Database) => db.prepare("SELECT * FROM messages ORDER BY sort_order").all() as Array<Record<string, unknown>>;

describe("migration 20260927091818: messages.end_reason", () => {
  test("before it the column does not exist", () => {
    const db = dbBefore();
    expect(() => db.query("SELECT end_reason FROM messages").get()).toThrow();
    db.close();
  });

  test("after it every existing row reads NULL and nothing else changed", () => {
    const db = dbBefore();
    const before = all(db);
    db.run(MIGRATION_SQL);
    const after = all(db);
    expect(after.map((r) => r.end_reason)).toEqual([null, null, null, null]);
    expect(after.map(({ end_reason: _, ...rest }) => rest)).toEqual(before);
    db.close();
  });

  test("the writers' values go in and read back", () => {
    const db = dbBefore();
    db.run(MIGRATION_SQL);
    db.run("UPDATE messages SET partial = 0, end_reason = 'cut-by-restart' WHERE session_key = 's1' AND partial = 1");
    db.run("UPDATE messages SET end_reason = 'done' WHERE id = 'a1'");
    expect(all(db).map((r) => [r.id, r.partial, r.end_reason])).toEqual([
      ["u1", 0, null], ["a1", 0, "done"], ["a2", 0, null], ["a3", 0, "cut-by-restart"],
    ]);
    db.close();
  });
});
