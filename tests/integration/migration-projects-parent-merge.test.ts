/**
 * The accorpa / separa migration: two columns on rows that already exist, with the
 * defaults that leave every project exactly as it was (top level, merge mode that
 * only matters once a parent is set).
 *
 * @covers WORKTREE-STD-06
 */
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SQL = readFileSync(join(import.meta.dir, "../../server/db/migrations/20261124110000-projects-parent-merge.sql"), "utf8");

function projectsDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  db.run(`CREATE TABLE projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, path TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  db.run("INSERT INTO projects (id, name, slug, path, created_at, updated_at) VALUES ('a', 'a', 'a', '/w/a', 't', 't')");
  return db;
}

test("existing rows come out top level with merge_mode accorpa", () => {
  const db = projectsDb();
  db.run(SQL);
  expect(db.query("SELECT parent_id, merge_mode FROM projects WHERE id = 'a'").get()).toEqual({ parent_id: null, merge_mode: "accorpa" });
});

test("merge_mode only takes the two values, and parent_id must point at a project", () => {
  const db = projectsDb();
  db.run(SQL);
  expect(() => db.run("UPDATE projects SET merge_mode = 'merge' WHERE id = 'a'")).toThrow();
  expect(() => db.run("UPDATE projects SET parent_id = 'ghost' WHERE id = 'a'")).toThrow();
  db.run("UPDATE projects SET merge_mode = 'separa' WHERE id = 'a'");
  expect((db.query("SELECT merge_mode FROM projects").get() as { merge_mode: string }).merge_mode).toBe("separa");
});
