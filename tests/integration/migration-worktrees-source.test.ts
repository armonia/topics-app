/**
 * The worktree creator migration: two columns on a table that already holds rows,
 * and every existing row reads as Topics' own.
 *
 * @covers WORKTREE-STD-08
 */
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("existing rows read source 'topics' and no session; new rows may name both", () => {
  const db = new Database(":memory:");
  db.run("CREATE TABLE worktrees (id TEXT PRIMARY KEY, abs_path TEXT NOT NULL UNIQUE)");
  db.run("INSERT INTO worktrees (id, abs_path) VALUES ('w1', '/r/p/a')");

  db.run(readFileSync(join(import.meta.dir, "../../server/db/migrations/20261124120000-worktrees-source.sql"), "utf8"));

  expect(db.query("SELECT id, abs_path, source, session_ref FROM worktrees").get())
    .toEqual({ id: "w1", abs_path: "/r/p/a", source: "topics", session_ref: null });
  db.run("INSERT INTO worktrees (id, abs_path, source, session_ref) VALUES ('w2', '/r/p/b', 'claude-code', 's1')");
  expect(db.query("SELECT source, session_ref FROM worktrees WHERE id = 'w2'").get()).toEqual({ source: "claude-code", session_ref: "s1" });
});
