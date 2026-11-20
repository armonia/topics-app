/**
 * A project folder moves and a symlink is left at the old path: the old board
 * id must reach the project's board (card 266a3e1e).
 * @covers KANBAN-05
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectIdForPath } from "../services/tasks";
import { canonicalBoardIdForPath, resetBoardAliasScan, syncBoardAliases } from "../lib/board-alias";
import { createTasksRouter } from "./tasks";
import { call, freshDb, makeCtx, rawCall } from "./tasks-test-support";

describe("old board id after a folder move", () => {
  let root: string;
  let db: Database;
  let router: ReturnType<typeof createTasksRouter>;
  let oldPath: string;
  let newPath: string;
  let oldId: string;
  let newId: string;
  const fixedPaths = ["/proj/one", "/proj/two", "/srv/apps/shop", "/x/proj"];

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "board-alias-")));
    oldPath = join(root, "app");
    newPath = join(root, "group", "app");
    mkdirSync(join(root, "group"));
    oldId = projectIdForPath(oldPath);
    newId = projectIdForPath(newPath);
    db = freshDb();
    // The migration file is EXECUTED as written (twice: it must be idempotent).
    const sql = readFileSync(join(import.meta.dir, "../db/migrations/20261120090000-board-aliases.sql"), "utf-8");
    db.exec(sql);
    db.exec(sql);
    // The project is registered under its REAL path only: the old path is
    // nowhere in the DB, just a symlink on disk after the move.
    db.run("INSERT INTO topics (id, name, session_key, provider, project_path) VALUES ('t1', 'app', 'sk-t1', 'codex', ?)", [newPath]);
    router = createTasksRouter(makeCtx(db, [], {}), undefined, { listProjectDirs: () => [newPath] });
    resetBoardAliasScan();
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const create = async (id: string, text: string) =>
    (await rawCall(router, "POST", `/api/boards/${id}/tasks`, { text }, { "X-Topics-Action-Origin": "interface" }))!;

  test("ids of paths that did not move do not change", () => {
    const before = fixedPaths.map(projectIdForPath);
    expect(fixedPaths.map(canonicalBoardIdForPath)).toEqual(before);
    expect(before[3]).toBe("proj-xwac8t");
  });

  test("old id reaches the board of the moved project", async () => {
    expect((await create(newId, "before move")).status).toBe(201);
    mkdirSync(newPath);
    symlinkSync(newPath, oldPath, "dir");
    expect(oldId).not.toBe(newId);
    expect(canonicalBoardIdForPath(oldPath)).toBe(newId);

    const made = await create(oldId, "from old id");
    expect(made.status).toBe(201);
    const onNew = await (await call(router, "GET", `/api/boards/${newId}/tasks`))!.json();
    expect((onNew.tasks ?? onNew).map((t: any) => t.text).sort()).toEqual(["before move", "from old id"]);

    const viaOld = await (await call(router, "GET", `/api/boards/${oldId}/tasks`))!.json();
    expect((viaOld.tasks ?? viaOld).map((t: any) => t.text).sort()).toEqual(["before move", "from old id"]);

    const count = db.query("SELECT count(*) AS n FROM tasks WHERE project_id = ?").get(oldId) as { n: number };
    expect(count.n).toBe(0);
  });

  test("the alias is persisted, so it survives the link going away", async () => {
    const row = db.query("SELECT new_id FROM board_aliases WHERE old_id = ?").get(oldId) as { new_id: string };
    expect(row.new_id).toBe(newId);
    rmSync(oldPath);
    const viaOld = await (await call(router, "GET", `/api/boards/${oldId}/tasks`))!.json();
    expect((viaOld.tasks ?? viaOld).length).toBe(2);
  });
});

describe("a board opened through a link keeps its own cards", () => {
  let root: string;
  let db: Database;
  let router: ReturnType<typeof createTasksRouter>;
  let linkPath: string;
  let realPath: string;

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "board-alias-link-")));
    linkPath = join(root, "app");
    realPath = join(root, "data", "app");
    db = freshDb();
    db.exec(readFileSync(join(import.meta.dir, "../db/migrations/20261120090000-board-aliases.sql"), "utf-8"));
    // The project is registered under the LINK path and its cards live on that
    // id: nothing moved, the folder is simply reached through a symlink.
    db.run("INSERT INTO topics (id, name, session_key, provider, project_path) VALUES ('t2', 'app', 'sk-t2', 'codex', ?)", [linkPath]);
    router = createTasksRouter(makeCtx(db, [], {}), undefined, { listProjectDirs: () => [linkPath] });
    resetBoardAliasScan();
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("the link's id is not sent to the empty board of the real folder", async () => {
    const linkId = projectIdForPath(linkPath);
    const made = await rawCall(router, "POST", `/api/boards/${linkId}/tasks`, { text: "own card" }, { "X-Topics-Action-Origin": "interface" });
    expect(made!.status).toBe(201);
    mkdirSync(realPath, { recursive: true });
    symlinkSync(realPath, linkPath, "dir");
    // Any miss on another board runs this scan: it records link id -> real id.
    syncBoardAliases(db);
    const row = db.query("SELECT new_id FROM board_aliases WHERE old_id = ?").get(linkId) as { new_id: string } | null;
    expect(row?.new_id).toBe(projectIdForPath(realPath));
    const viaLink = await (await call(router, "GET", `/api/boards/${linkId}/tasks`))!.json();
    expect((viaLink.tasks ?? viaLink).map((t: any) => t.text)).toEqual(["own card"]);
  });
});
