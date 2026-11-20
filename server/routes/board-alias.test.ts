/**
 * A project folder moves and a symlink is left at the old path: the old board
 * id must reach the project's board (card 266a3e1e).
 * @covers KANBAN-05
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectIdForPath } from "../services/tasks";
import { canonicalBoardIdForPath } from "../lib/board-alias";
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
    mkdirSync(oldPath);
    mkdirSync(join(root, "group"));
    oldId = projectIdForPath(oldPath);
    newId = projectIdForPath(newPath);
    db = freshDb();
    db.run("INSERT INTO topics (id, name, session_key, provider, project_path) VALUES ('t1', 'app', 'sk-t1', 'codex', ?)", [oldPath]);
    router = createTasksRouter(makeCtx(db, [], {}), undefined, { listProjectDirs: () => [oldPath] });
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
    renameSync(oldPath, newPath);
    symlinkSync(newPath, oldPath);
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
});
