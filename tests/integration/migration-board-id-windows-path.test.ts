/**
 * `20260907132557-board-id-windows-path.sql` — the board ids born on Windows.
 *
 * Until 06/09 `projectIdForPath` cut the folder name on `/` alone, so on
 * Windows (no `/` in a path) the id was the WHOLE path plus the hash. Those ids
 * are already written in `tasks`, `board_settings` and `board_memory`, and this
 * migration cuts them where the function now cuts: after the LAST backslash.
 *
 * What this bench watches, one by one:
 *   1. the realigned id is EXACTLY what `projectIdForPath` returns today for
 *      that same path — the migration and the function must cut at the same
 *      point, or the rows land under a third id nobody asks for;
 *   2. a slash-only id (the lying tail: it looks like an id, it has no backslash)
 *      is NOT touched — that is the half of the contract that gets forgotten;
 *   3. running it twice changes nothing;
 *   4. on `board_settings`, where `project_id` is the PRIMARY KEY, the broken
 *      twin does not collide with the row already under the right id.
 *
 * The file is read and EXECUTED as it is: a rewritten copy would prove the
 * copy.
 * @covers SCHEMA-07
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import path from "node:path";
import { projectIdForPath } from "../../shared/board";
import { PROJECT_ROOT } from "./helpers";

const MIGRATION_SQL = fs.readFileSync(
  path.join(PROJECT_ROOT, "server/db/migrations", "20260907132557-board-id-windows-path.sql"),
  "utf-8",
);

const WINDOWS_PATH = "C:\\Users\\someone\\AppData\\Local\\Temp\\e2e-archrestore-123";
const SLASH_PATH = "/Users/someone/Projects/topics-app";

/** The id as it was WRITTEN before the fix: the whole path, then the hash. */
function brokenId(projectPath: string): string {
  const goodId = projectIdForPath(projectPath);
  const hash = goodId.slice(goodId.lastIndexOf("-"));
  return projectPath.replace(/[\\/]+$/, "") + hash;
}

/** The three tables that hold a board id, as they are on disk today. */
function dbBefore(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, text TEXT NOT NULL)`);
  db.run(`CREATE TABLE board_settings (project_id TEXT PRIMARY KEY, max_agents INTEGER DEFAULT 5)`);
  db.run(`CREATE TABLE board_memory (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, content TEXT NOT NULL)`);
  return db;
}

describe("migration: an id written with the whole Windows path goes back to the folder", () => {
  test("the realigned id is the one projectIdForPath returns today", () => {
    const db = dbBefore();
    db.run(`INSERT INTO tasks (id, project_id, text) VALUES ('t1', ?, 'card')`, [brokenId(WINDOWS_PATH)]);
    db.run(`INSERT INTO board_memory (id, project_id, content) VALUES ('m1', ?, 'note')`, [brokenId(WINDOWS_PATH)]);
    db.run(`INSERT INTO board_settings (project_id, max_agents) VALUES (?, 3)`, [brokenId(WINDOWS_PATH)]);

    db.run(MIGRATION_SQL);

    const expected = projectIdForPath(WINDOWS_PATH);
    expect(expected).toBe("e2e-archrestore-123" + expected.slice(expected.lastIndexOf("-")));
    expect((db.query("SELECT project_id AS p FROM tasks").get() as { p: string }).p).toBe(expected);
    expect((db.query("SELECT project_id AS p FROM board_memory").get() as { p: string }).p).toBe(expected);
    expect((db.query("SELECT project_id AS p FROM board_settings").get() as { p: string }).p).toBe(expected);
  });

  test("the guard against a green that did nothing: exactly the broken rows move", () => {
    const db = dbBefore();
    db.run(`INSERT INTO tasks (id, project_id, text) VALUES ('t1', ?, 'a')`, [brokenId(WINDOWS_PATH)]);
    db.run(`INSERT INTO tasks (id, project_id, text) VALUES ('t2', ?, 'b')`, [brokenId(WINDOWS_PATH)]);
    db.run(`INSERT INTO tasks (id, project_id, text) VALUES ('t3', ?, 'c')`, [projectIdForPath(SLASH_PATH)]);

    db.run(MIGRATION_SQL);

    const moved = db.query(`SELECT count(*) AS n FROM tasks WHERE project_id = ?`).get(projectIdForPath(WINDOWS_PATH)) as { n: number };
    expect(moved.n).toBe(2);
    const still = db.query(`SELECT count(*) AS n FROM tasks WHERE project_id = ?`).get(projectIdForPath(SLASH_PATH)) as { n: number };
    expect(still.n).toBe(1);
    const left = db.query(`SELECT count(*) AS n FROM tasks WHERE instr(project_id, char(92)) > 0`).get() as { n: number };
    expect(left.n).toBe(0);
  });

  test("the lying tail: a slash-only id resembles the criterion without being it, and is left alone", () => {
    const db = dbBefore();
    const slashId = projectIdForPath(SLASH_PATH);
    db.run(`INSERT INTO tasks (id, project_id, text) VALUES ('t1', ?, 'a')`, [slashId]);
    db.run(`INSERT INTO board_settings (project_id, max_agents) VALUES (?, 7)`, [slashId]);
    db.run(`INSERT INTO board_memory (id, project_id, content) VALUES ('m1', ?, 'n')`, [slashId]);

    db.run(MIGRATION_SQL);

    expect((db.query("SELECT project_id AS p FROM tasks").get() as { p: string }).p).toBe(slashId);
    expect((db.query("SELECT max_agents AS m FROM board_settings WHERE project_id = ?").get(slashId) as { m: number }).m).toBe(7);
    expect((db.query("SELECT project_id AS p FROM board_memory").get() as { p: string }).p).toBe(slashId);
  });

  test("board_settings: the broken twin does not collide with the row already right", () => {
    const db = dbBefore();
    const right = projectIdForPath(WINDOWS_PATH);
    db.run(`INSERT INTO board_settings (project_id, max_agents) VALUES (?, 9)`, [right]);
    db.run(`INSERT INTO board_settings (project_id, max_agents) VALUES (?, 1)`, [brokenId(WINDOWS_PATH)]);

    db.run(MIGRATION_SQL);

    const rows = db.query("SELECT project_id AS p, max_agents AS m FROM board_settings").all() as { p: string; m: number }[];
    expect(rows).toEqual([{ p: right, m: 9 }]);
  });

  test("run twice: the second run changes nothing", () => {
    const db = dbBefore();
    db.run(`INSERT INTO tasks (id, project_id, text) VALUES ('t1', ?, 'a')`, [brokenId(WINDOWS_PATH)]);
    db.run(MIGRATION_SQL);
    const after = db.query("SELECT project_id AS p FROM tasks").all();
    db.run(MIGRATION_SQL);
    expect(db.query("SELECT project_id AS p FROM tasks").all()).toEqual(after);
  });
});
