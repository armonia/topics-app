/**
 * `20260912081500-task-comment-quiet.sql` — the column that remembers a comment
 * was a NOTE.
 *
 * What is worth proving about a migration that adds a column: that the FILE
 * runs (not a copy of it rewritten here), that rows written BEFORE stay
 * distinguishable from rows written after — because the reader that will use it
 * (`pendingQuestionComment`) must treat absence as "not quiet" and never as
 * "quiet" — and that the constraint refuses anything but 0/1, or the column
 * becomes the place where somebody writes a string.
 *
 * @covers SCHEMA-07
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "./helpers";

const MIGRATION_SQL = fs.readFileSync(
  path.join(PROJECT_ROOT, "server/db/migrations/20260912081500-task-comment-quiet.sql"),
  "utf-8",
);

function makeDb(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE task_comments (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    author TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    mentions TEXT,
    created_at TEXT,
    media TEXT,
    kind TEXT,
    message_id TEXT,
    origin TEXT
  )`);
  db.prepare("INSERT INTO task_comments (id, task_id, author, content, kind, created_at) VALUES ('older', 't1', 'user', 'written before the column existed', 'comment', '2026-09-01T00:00:00Z')").run();
  return db;
}

describe("task_comments.quiet", () => {
  test("history stays NULL, which reads as «we do not know», not «quiet»", () => {
    const db = makeDb();
    db.run(MIGRATION_SQL);
    const row = db.prepare("SELECT quiet FROM task_comments WHERE id = 'older'").get() as { quiet: unknown };
    expect(row.quiet).toBeNull();
    db.close();
  });

  test("a new note is marked, an answer is not", () => {
    const db = makeDb();
    db.run(MIGRATION_SQL);
    const insert = db.prepare("INSERT INTO task_comments (id, task_id, author, content, kind, created_at, quiet) VALUES (?, 't1', 'user', ?, 'comment', '2026-09-12T00:00:00Z', ?)");
    insert.run("note", "just annotating", 1);
    insert.run("answer", "Requeue the subtasks", null);
    const quiet = db.prepare("SELECT id FROM task_comments WHERE quiet = 1").all() as Array<{ id: string }>;
    expect(quiet.map((row) => row.id)).toEqual(["note"]);
    db.close();
  });

  test("the constraint refuses anything that is not 0 or 1", () => {
    const db = makeDb();
    db.run(MIGRATION_SQL);
    expect(() => db.prepare(
      "INSERT INTO task_comments (id, task_id, author, content, kind, created_at, quiet) VALUES ('x', 't1', 'user', 'x', 'comment', '2026-09-12T00:00:00Z', 'yes')",
    ).run()).toThrow();
    db.close();
  });

  test("running it twice throws, and that is correct: the runner applies it once", () => {
    const db = makeDb();
    db.run(MIGRATION_SQL);
    expect(() => db.run(MIGRATION_SQL)).toThrow(/duplicate column/i);
    db.close();
  });
});
