/**
 * The backfill that gives worktree-projects their parent: real git repositories in
 * temp folders, a synthetic database, and a check that no other table is written.
 *
 * @covers WORKTREE-STD-06
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backfillProjectParents } from "./project-family-backfill";

let base = "";
let main = "";
let worktree = "";
let sibling = "";
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "family-backfill-")));
  main = join(base, "shopcms");
  worktree = join(base, "wt", "shopcms", "moduli");
  sibling = join(base, "acme-site");
  for (const dir of [main, sibling]) {
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, "a.txt"), "a");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "init");
  }
  mkdirSync(join(base, "wt", "shopcms"), { recursive: true });
  git(main, "worktree", "add", "-q", "-b", "moduli", worktree);
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

function makeDb(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, path TEXT NOT NULL,
    color TEXT, icon TEXT, archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  db.run(readFileSync(join(import.meta.dir, "../db/migrations/20261124110000-projects-parent-merge.sql"), "utf8"));
  db.run("CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT)");
  db.run("INSERT INTO tasks VALUES ('t1', 'moduli-abc123')");
  const add = db.prepare("INSERT INTO projects (id, name, slug, path, created_at, updated_at) VALUES (?, ?, ?, ?, 't', 't')");
  add.run("p-main", "shopcms", "shopcms", main);
  add.run("p-wt", "moduli", "shopcms-moduli", worktree);
  add.run("p-site", "acme-site", "acme-site", sibling);
  return db;
}

const parentOf = (db: Database, id: string) => (db.query("SELECT parent_id, merge_mode FROM projects WHERE id = ?").get(id) as { parent_id: string | null; merge_mode: string });

describe("backfillProjectParents", () => {
  test("a linked worktree registered as a project gets the repository's project as parent, accorpa", () => {
    const db = makeDb();
    const result = backfillProjectParents(db);
    expect(result.assigned.map((a) => [a.slug, a.parentSlug])).toEqual([["shopcms-moduli", "shopcms"]]);
    expect(result.unresolved).toEqual([]);
    expect(parentOf(db, "p-wt")).toEqual({ parent_id: "p-main", merge_mode: "accorpa" });
    expect(parentOf(db, "p-main").parent_id).toBeNull();
    expect(parentOf(db, "p-site").parent_id).toBeNull();
  });

  test("runs twice to the same result and never rewrites tasks", () => {
    const db = makeDb();
    const tasksBefore = JSON.stringify(db.query("SELECT * FROM tasks").all());
    backfillProjectParents(db);
    const again = backfillProjectParents(db);
    expect(again.assigned).toEqual([]);
    expect(JSON.stringify(db.query("SELECT * FROM tasks").all())).toBe(tasksBefore);
  });

  test("a worktree-project the person took out of its family stays out at the next boot", () => {
    const db = makeDb();
    backfillProjectParents(db);
    // «Togli da X» as the store writes it (project-store.family.test.ts): top level, 'separa'.
    db.run("UPDATE projects SET parent_id = NULL, merge_mode = 'separa' WHERE id = 'p-wt'");
    const again = backfillProjectParents(db);
    expect(again.assigned).toEqual([]);
    expect(parentOf(db, "p-wt").parent_id).toBeNull();
  });

  test("a dry run reports the plan and writes nothing", () => {
    const db = makeDb();
    const result = backfillProjectParents(db, { apply: false });
    expect(result.assigned).toHaveLength(1);
    expect(parentOf(db, "p-wt").parent_id).toBeNull();
  });

  test("a folder that is gone is resolved from its place under the worktree root", () => {
    const db = makeDb();
    const root = join(base, "root");
    db.run("INSERT INTO projects (id, name, slug, path, created_at, updated_at) VALUES ('p-gone', 'gone', 'gone', ?, 't', 't')", [join(root, "shopcms", "vanished")]);
    const result = backfillProjectParents(db, { worktreeRoot: root });
    expect(result.assigned.map((a) => a.slug)).toContain("gone");
    expect(parentOf(db, "p-gone").parent_id).toBe("p-main");
  });

  test("a worktree whose repository is not registered stays unresolved and untouched", () => {
    const db = makeDb();
    db.run("DELETE FROM projects WHERE id = 'p-main'");
    const result = backfillProjectParents(db);
    expect(result.unresolved.map((u) => u.slug)).toEqual(["shopcms-moduli"]);
    expect(parentOf(db, "p-wt").parent_id).toBeNull();
  });

  test("a database without the family columns is left alone", () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, slug TEXT, path TEXT, archived INTEGER DEFAULT 0)");
    db.run("INSERT INTO projects (id, name, slug, path) VALUES ('p', 'p', 'p', '/nonexistent/x')");
    expect(backfillProjectParents(db)).toEqual({ assigned: [], unresolved: [] });
  });
});
