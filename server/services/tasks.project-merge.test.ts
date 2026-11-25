/**
 * Accorpa / separa on the board: the parent's list reads its own cards plus the
 * cards of the children merged into it, and nothing in `tasks` ever changes.
 *
 * @covers WORKTREE-STD-06
 */
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { freshDb, svc } from "./tasks-test-db";
import { boardIdOfRow } from "../../shared/project-family";

const PARENT_PATH = "/w/Shop/shopcms";
const CHILD_PATH = "/w/Shop/shopcms-moduli";
const LONER_PATH = "/w/Other/acme-site";
const PARENT = boardIdOfRow({ path: PARENT_PATH });
const CHILD = boardIdOfRow({ path: CHILD_PATH });
const LONER = boardIdOfRow({ path: LONER_PATH });

/** The `projects` table as production has it: the 016 base plus the family migration, executed from the file. */
function withProjects(db: Database): Database {
  db.run(`CREATE TABLE projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, path TEXT NOT NULL,
    color TEXT, icon TEXT, archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  db.run(readFileSync(join(import.meta.dir, "../db/migrations/20261124110000-projects-parent-merge.sql"), "utf8"));
  const add = db.prepare("INSERT INTO projects (id, name, slug, path, created_at, updated_at) VALUES (?, ?, ?, ?, 't', 't')");
  add.run("row-parent", "shopcms", "shopcms", PARENT_PATH);
  add.run("row-child", "shopcms-moduli", "shopcms-moduli", CHILD_PATH);
  add.run("row-loner", "acme-site", "acme-site", LONER_PATH);
  return db;
}

function merge(db: Database, mode: "accorpa" | "separa" | null, parent: string | null = "row-parent") {
  db.run("UPDATE projects SET parent_id = ?, merge_mode = ? WHERE id = 'row-child'", [mode === null ? null : parent, mode ?? "accorpa"]);
}

function seed(db: Database) {
  const s = svc(db);
  const own = s.create({ projectId: PARENT, text: "parent card" });
  const kid1 = s.create({ projectId: CHILD, text: "child card 1" });
  const kid2 = s.create({ projectId: CHILD, text: "child card 2" });
  const alien = s.create({ projectId: LONER, text: "alien card" });
  return { s, own, kid1, kid2, alien };
}

const texts = (rows: Array<{ text: string }>) => rows.map((t) => t.text).sort();

describe("the parent board", () => {
  test("accorpa: the parent lists its own cards and the child's, each card keeps its own project", () => {
    const db = withProjects(freshDb());
    merge(db, "accorpa");
    const { s } = seed(db);
    const rows = s.list({ scope: "project", projectId: PARENT, includeChildBoards: true });
    expect(texts(rows)).toEqual(["child card 1", "child card 2", "parent card"]);
    expect(rows.find((t) => t.text === "child card 1")!.projectId).toBe(CHILD);
    expect(rows.find((t) => t.text === "parent card")!.projectId).toBe(PARENT);
  });

  test("separa: the child's cards leave the parent's board, and come back with accorpa", () => {
    const db = withProjects(freshDb());
    merge(db, "separa");
    const { s } = seed(db);
    expect(texts(s.list({ scope: "project", projectId: PARENT, includeChildBoards: true }))).toEqual(["parent card"]);
    merge(db, "accorpa");
    expect(s.list({ scope: "project", projectId: PARENT, includeChildBoards: true })).toHaveLength(3);
  });

  test("a child board never shows the parent's cards, and a project outside the family is unaffected", () => {
    const db = withProjects(freshDb());
    merge(db, "accorpa");
    const { s } = seed(db);
    expect(texts(s.list({ scope: "project", projectId: CHILD, includeChildBoards: true }))).toEqual(["child card 1", "child card 2"]);
    expect(texts(s.list({ scope: "project", projectId: LONER, includeChildBoards: true }))).toEqual(["alien card"]);
  });

  test("without the flag the list is the literal project: dispatch and agent doors never see merged cards", () => {
    const db = withProjects(freshDb());
    merge(db, "accorpa");
    const { s } = seed(db);
    expect(texts(s.list({ scope: "project", projectId: PARENT }))).toEqual(["parent card"]);
  });

  test("an archived child leaves the board", () => {
    const db = withProjects(freshDb());
    merge(db, "accorpa");
    db.run("UPDATE projects SET archived = 1 WHERE id = 'row-child'");
    const { s } = seed(db);
    expect(texts(s.list({ scope: "project", projectId: PARENT, includeChildBoards: true }))).toEqual(["parent card"]);
  });

  test("status and archive filters apply across the family", () => {
    const db = withProjects(freshDb());
    merge(db, "accorpa");
    const { s, kid1 } = seed(db);
    s.update({ taskId: kid1.id, actor: "human", by: "tester", patch: { status: "todo" }, projectId: CHILD });
    const todo = s.list({ scope: "project", projectId: PARENT, includeChildBoards: true, status: "todo" });
    expect(todo.map((t) => t.id)).toEqual([kid1.id]);
  });

  test("a card created from the parent goes to the parent", () => {
    const db = withProjects(freshDb());
    merge(db, "accorpa");
    const { s } = seed(db);
    const made = s.create({ projectId: PARENT, text: "new from parent" });
    expect(made.projectId).toBe(PARENT);
  });

  test("toggling accorpa / separa rewrites no row of tasks", () => {
    const db = withProjects(freshDb());
    const { s } = seed(db);
    const snapshot = () => JSON.stringify(db.query("SELECT * FROM tasks ORDER BY id").all());
    const before = snapshot();
    for (const mode of ["accorpa", "separa", "accorpa"] as const) {
      merge(db, mode);
      s.list({ scope: "project", projectId: PARENT, includeChildBoards: true });
    }
    merge(db, null);
    expect(snapshot()).toBe(before);
  });

  test("a database without the family columns (older schema) lists the literal project", () => {
    const db = freshDb();
    db.run("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, slug TEXT, path TEXT, archived INTEGER DEFAULT 0)");
    const { s } = seed(db);
    expect(texts(s.list({ scope: "project", projectId: PARENT, includeChildBoards: true }))).toEqual(["parent card"]);
  });
});

describe("board settings of a merged project", () => {
  const setEffort = (db: Database, boardId: string, effort: string) =>
    db.run("INSERT INTO board_settings (project_id, dispatch_effort) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET dispatch_effort = excluded.dispatch_effort", [boardId, effort]);

  test("without a row of its own the child takes only the parent's display settings, never how it dispatches, merges or deploys", () => {
    const db = withProjects(freshDb());
    merge(db, "accorpa");
    setEffort(db, PARENT, "high");
    // The bench table is a subset of the real one: the three columns this case reads are added here.
    for (const col of ["dispatch_auto_merge INTEGER", "deploy_command TEXT", "language TEXT"]) db.run(`ALTER TABLE board_settings ADD COLUMN ${col}`);
    db.run("UPDATE board_settings SET dispatch_auto_merge = 1, deploy_command = 'make deploy', dispatch_use_worktree = 0, language = 'en' WHERE project_id = ?", [PARENT]);
    const settings = svc(db).getBoardSettings(CHILD);
    expect(settings.projectId).toBe(CHILD);
    expect(settings.language).toBe("en");
    expect(settings.dispatchEffort).toBe("medium");
    expect(settings.dispatchAutoMerge).toBe(false);
    expect(settings.deployCommand).toBe("");
    expect(settings.dispatchUseWorktree).toBe(true);
  });

  test("its own row wins over the parent's", () => {
    const db = withProjects(freshDb());
    merge(db, "accorpa");
    setEffort(db, PARENT, "high");
    setEffort(db, CHILD, "low");
    expect(svc(db).getBoardSettings(CHILD).dispatchEffort).toBe("low");
  });

  test("separa and a project outside the family read only their own", () => {
    const db = withProjects(freshDb());
    setEffort(db, PARENT, "high");
    merge(db, "separa");
    expect(svc(db).getBoardSettings(CHILD).dispatchEffort).toBe("medium");
    expect(svc(db).getBoardSettings(LONER).dispatchEffort).toBe("medium");
  });
});
