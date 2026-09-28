/**
 * `20260928170113-resend-counts.sql`: the resume sweep's count of resends, per
 * message (card 069f823e).
 * @covers RESUME-01
 *
 * The file itself, run against a synthetic database with the `messages` table
 * of 001 plus the columns the sweep reads, holding a chain in flight: the table appears empty
 * (nothing is backfilled: the chat has no count, and the sweep reads such a
 * chain off its rows), no message moves, and the statements
 * `lib/resend-count.ts` runs work on it.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "./helpers";
import { chatHasCounts, noteResendCopy, recordResend, resendChainOf } from "../../server/lib/resend-count";

const read = (name: string) => fs.readFileSync(path.join(PROJECT_ROOT, "server/db/migrations", name), "utf-8");
const MIGRATION_SQL = read("20260928170113-resend-counts.sql");
const SK = "topic:x";

function dbBefore(): Database {
  const db = new Database(":memory:");
  for (const statement of read("001-initial.sql").split(/;\s*\n/)) {
    if (!/create\s+table\s+(if\s+not\s+exists\s+)?messages\b/i.test(statement)) continue;
    db.run(statement);
  }
  // The columns of 005, 014 and 015 the sweep reads, then `end_reason`.
  db.run("ALTER TABLE messages ADD COLUMN parent_id TEXT");
  db.run("ALTER TABLE messages ADD COLUMN latency_ms INTEGER");
  db.run("ALTER TABLE messages ADD COLUMN blocks TEXT");
  db.run(read("20260927091818-message-end-reason.sql"));
  // A chain in flight at deploy: the message, its cut traced for the first
  // resend, the resend's copy, and its answer cut again.
  const row = db.prepare("INSERT INTO messages (id, session_key, role, content, blocks, partial, timestamp, sort_order, parent_id, end_reason) VALUES (?, ?, ?, ?, ?, 0, '2026-09-28', ?, ?, ?)");
  row.run("u0", SK, "user", "fai il deploy", null, 0, null, null);
  row.run("a1", SK, "assistant", "", JSON.stringify([{ kind: "error", text: "Turno interrotto." }, { kind: "ripreso", attempt: 1 }]), 1, "u0", "stopped");
  row.run("u2", SK, "user", "fai il deploy", null, 2, "a1", null);
  row.run("a3", SK, "assistant", "", JSON.stringify([{ kind: "ripreso", attempt: 1 }, { kind: "error", text: "Turno interrotto." }]), 3, "u2", "stopped");
  return db;
}

// `prepare`, not the cached `query`: a statement cached before the migration keeps the old schema.
const messages = (db: Database) => db.prepare("SELECT * FROM messages ORDER BY sort_order").all();

describe("migration 20260928170113: resend_counts", () => {
  test("before it the table does not exist", () => {
    const db = dbBefore();
    expect(() => db.prepare("SELECT * FROM resend_counts").all()).toThrow();
    db.close();
  });

  test("after it the table is empty, a chain in flight has no count, and no message moved", () => {
    const db = dbBefore();
    const before = messages(db);
    db.run(MIGRATION_SQL);
    expect(db.prepare("SELECT * FROM resend_counts").all()).toEqual([]);
    expect(resendChainOf(db, SK, "u2")).toBeNull();
    expect(chatHasCounts(db, SK)).toBe(false);
    expect(messages(db)).toEqual(before);
    db.close();
  });

  test("a resend's count is found from the copy the route wrote, until that copy is answered", () => {
    const db = dbBefore();
    db.run(MIGRATION_SQL);
    recordResend(db, SK, { messageId: "u2", attempts: 2, freeProbes: 1 });
    expect(resendChainOf(db, SK, "u2")).toEqual({ messageId: "u2", attempts: 2, freeProbes: 1 });
    // From its first counted resend on, the chat's numbers are the table's.
    expect(chatHasCounts(db, SK)).toBe(true);
    // The route writes the resend's copy of the message, and the chain goes on from it.
    db.run("INSERT INTO messages (id, session_key, role, content, partial, timestamp, sort_order, parent_id) VALUES ('u4', ?, 'user', 'fai il deploy', 0, '2026-09-28', 4, 'a3')", [SK]);
    noteResendCopy(db, SK, "u2", "u4");
    recordResend(db, SK, { messageId: "u2", attempts: 3, freeProbes: 1 });
    expect(resendChainOf(db, SK, "u4")).toEqual({ messageId: "u2", attempts: 3, freeProbes: 1 });
    // A copy left under a cut is still the chain's, and so is one under a row
    // written whole with no latency (a report, a notice); a turn after it the
    // route closed by itself ends the chain.
    db.run("INSERT INTO messages (id, session_key, role, content, partial, timestamp, sort_order, parent_id, end_reason) VALUES ('a5', ?, 'assistant', 'fatto', 0, '2026-09-28', 5, 'u4', 'error')", [SK]);
    expect(resendChainOf(db, SK, "u4")?.attempts).toBe(3);
    db.run("UPDATE messages SET end_reason = 'done' WHERE id = 'a5'");
    expect(resendChainOf(db, SK, "u4")?.attempts).toBe(3);
    db.run("UPDATE messages SET latency_ms = 1200 WHERE id = 'a5'");
    expect(resendChainOf(db, SK, "u4")).toEqual({ messageId: "u4", attempts: 0, freeProbes: 0 });
    // A message nobody resent has no count, and another session's copy is not this one's.
    expect(resendChainOf(db, SK, "u0")).toBeNull();
    expect(resendChainOf(db, "topic:y", "u4")).toBeNull();
    db.close();
  });
});
