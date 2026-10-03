/**
 * `20261003214001-subject-attention.sql`: the table of the attention store
 * (notifications-redesign, design section 2.1 and 11).
 *
 * What is worth proving of a schema-only migration: that the FILE runs (not a
 * copy rewritten here) on a database shaped like the live one, that it runs
 * twice without harm (the watcher applies a new migration file to the live
 * database within seconds, and a re-run must not fail), that it backfills
 * nothing, and that the store's own write and read go through it.
 * @covers ATTN-07
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "./helpers";

const MIGRATION_SQL = fs.readFileSync(
  path.join(PROJECT_ROOT, "server/db/migrations/20261003214001-subject-attention.sql"),
  "utf-8",
);

function liveShapedDb(): Database {
  const db = new Database(":memory:");
  // A few tables of the live schema, with rows: the migration must touch none of them.
  db.run("CREATE TABLE topics (id TEXT PRIMARY KEY, session_key TEXT, archived INTEGER DEFAULT 0)");
  db.run("CREATE TABLE notification_log (id TEXT PRIMARY KEY, group_key TEXT, seen_at TEXT)");
  db.run("CREATE TABLE unread (topic_id TEXT PRIMARY KEY, unread_count INTEGER)");
  for (let i = 0; i < 50; i++) {
    db.run("INSERT INTO topics VALUES (?, ?, 0)", [`t${i}`, `topic:t${i}`]);
    db.run("INSERT INTO notification_log VALUES (?, ?, NULL)", [`n${i}`, `topic:t${i}`]);
    db.run("INSERT INTO unread VALUES (?, 3)", [`t${i}`]);
  }
  return db;
}

describe("migration subject-attention", () => {
  test("creates the table and its state index, and backfills nothing", () => {
    const db = liveShapedDb();
    db.run(MIGRATION_SQL);
    const cols = (db.query("PRAGMA table_info(subject_attention)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual([
      "subject", "state", "reason", "outcome", "detail", "since", "epoch", "epoch_cause",
      "seen_epoch", "last_turn", "seen_at", "background", "updated_at",
    ]);
    const idx = (db.query("PRAGMA index_list(subject_attention)").all() as { name: string }[]).map((i) => i.name);
    expect(idx).toContain("idx_subject_attention_state");
    expect((db.query("SELECT COUNT(*) AS c FROM subject_attention").get() as { c: number }).c).toBe(0);
    // Nothing else moved.
    expect((db.query("SELECT COUNT(*) AS c FROM notification_log WHERE seen_at IS NULL").get() as { c: number }).c).toBe(50);
    expect((db.query("SELECT SUM(unread_count) AS s FROM unread").get() as { s: number }).s).toBe(150);
    db.close();
  });

  test("runs twice without failing", () => {
    const db = liveShapedDb();
    db.run(MIGRATION_SQL);
    expect(() => db.run(MIGRATION_SQL)).not.toThrow();
    db.close();
  });

  test("a row the store writes reads back whole, with the defaults on the epochs", () => {
    const db = liveShapedDb();
    db.run(MIGRATION_SQL);
    db.run(
      "INSERT INTO subject_attention (subject, state, since, last_turn, background, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["topic:t1", "background", "2026-10-03T21:40:00.000Z", JSON.stringify({ id: "m1", outcome: "done", at: "2026-10-03T21:40:00.000Z" }),
        JSON.stringify({ b1: { kind: "bash", label: "sleep 40", startedAt: "2026-10-03T21:39:00.000Z" } }), "2026-10-03T21:40:00.000Z"],
    );
    const row = db.query("SELECT * FROM subject_attention WHERE subject = 'topic:t1'").get() as Record<string, unknown>;
    expect(row.epoch).toBe(0);
    expect(row.seen_epoch).toBe(0);
    expect(JSON.parse(row.background as string).b1.kind).toBe("bash");
    expect((db.query("SELECT COUNT(*) AS c FROM subject_attention WHERE state = 'background'").get() as { c: number }).c).toBe(1);
    db.close();
  });
});
