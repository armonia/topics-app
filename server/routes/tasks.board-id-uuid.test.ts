/**
 * A task born under the `projects.id` UUID instead of the board id.
 *
 * Happened on 02/09/2026 on the live board: 25 tasks carried a raw UUID as
 * `project_id`, so the kanban grew a second column beside the real project —
 * live-translate, armonia-site and topics-app each appeared twice — and
 * nothing errored anywhere. `tasks.project_id` is `projectIdForPath(path)`;
 * `projects.id` is a different namespace, and a caller reading the id from
 * `GET /api/projects` picks the wrong one without any way to notice.
 * @covers KANBAN-05
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createTasksRouter } from "./tasks";
import { projectIdForPath } from "../../shared/board";
import { freshDb, makeCtx, call } from "./tasks-test-support";

const UUID = "75e5098a-c416-4676-9956-99ca9916cd28";
const PATH = "/proj/one";

describe("board id from the projects UUID", () => {
  let db: Database; let router: ReturnType<typeof createTasksRouter>;
  beforeEach(() => {
    db = freshDb();
    db.run("CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, path TEXT NOT NULL)");
    db.run("INSERT INTO projects (id, path) VALUES (?, ?)", [UUID, PATH]);
    router = createTasksRouter(makeCtx(db, []));
  });

  test("a create addressed by UUID lands on the real board, not on a column nobody reads", async () => {
    const resp = (await call(router, "POST", `/api/boards/${UUID}/tasks`, { text: "x" }))!;
    expect(resp.status).toBe(201);
    const task = await resp.json();
    expect(task.projectId).toBe(projectIdForPath(PATH));
    expect(task.projectId).not.toBe(UUID);
  });

  test("a UUID with no project row passes through untouched (legacy boards keyed by projects.id)", async () => {
    const orphan = "00000000-0000-4000-8000-000000000000";
    const resp = (await call(router, "POST", `/api/boards/${orphan}/tasks`, { text: "y" }))!;
    expect(resp.status).toBe(201);
    expect((await resp.json()).projectId).toBe(orphan);
  });

  test("a board id is not a UUID and is never rewritten", async () => {
    const resp = (await call(router, "POST", "/api/boards/topics-app-ar3jt5/tasks", { text: "z" }))!;
    expect(resp.status).toBe(201);
    expect((await resp.json()).projectId).toBe("topics-app-ar3jt5");
  });
});
