/**
 * @covers KANBAN-124
 *
 * A FUTURE STEP IS A CARD WITH A REAL LINK, NEVER A PROMISE IN A COMMENT.
 *
 * Review feedback 26/11, point 4: the previous delivery claimed both the
 * session-scoped `create_task` and the `update_task` MCP tools could wire
 * `blockedByTaskId`, but only checked a stub request body. Through the real
 * HTTP routes, `create_task` silently dropped the field (routes/tasks.ts),
 * and `update_task` answered 400 `unapplicable_field` because `blockedByTaskId`
 * was missing from `AGENT_FIELDS` (routes/task-patch.ts).
 *
 * The blocker is created through the SAME session route: the edge stays inside
 * one board, exactly like the `parent_task_id` guard next to it, so the blocker
 * has to live on the session's own board.
 */
import { describe, expect, test } from "bun:test";
import { createTasksRouter } from "./tasks";
import { freshDb, makeCtx, rawCall, withOwnSessionToken } from "./tasks-test-support";

describe("session route POST /tasks forwards blockedByTaskId", () => {
  test("the created card carries the link", async () => {
    const db = freshDb();
    const r = createTasksRouter(makeCtx(db, []));
    const blocker = await (await rawCall(r, "POST", "/api/sessions/s1/tasks", { text: "blocker" }, withOwnSessionToken("/api/sessions/s1/tasks")))!.json();

    const res = await rawCall(
      r, "POST", "/api/sessions/s1/tasks",
      { text: "dependent step", blockedByTaskId: blocker.id },
      withOwnSessionToken("/api/sessions/s1/tasks"),
    );
    expect(res!.status).toBe(201);
    const created = await res!.json();
    expect(created.blockedByTaskId).toBe(blocker.id);

    const row = db.prepare("SELECT blocked_by_task_id FROM tasks WHERE id = ?").get(created.id) as any;
    expect(row.blocked_by_task_id).toBe(blocker.id);
  });
});

describe("session route PATCH /tasks/:id accepts blockedByTaskId from an agent", () => {
  test("the link is persisted, not rejected as unapplicable_field", async () => {
    const db = freshDb();
    const r = createTasksRouter(makeCtx(db, []));
    const blocker = await (await rawCall(r, "POST", "/api/sessions/s1/tasks", { text: "blocker" }, withOwnSessionToken("/api/sessions/s1/tasks")))!.json();
    const dependent = await (await rawCall(r, "POST", "/api/sessions/s1/tasks", { text: "step" }, withOwnSessionToken("/api/sessions/s1/tasks")))!.json();

    const res = await rawCall(
      r, "PATCH", `/api/sessions/s1/tasks/${dependent.id}`,
      { blockedByTaskId: blocker.id },
      withOwnSessionToken(`/api/sessions/s1/tasks/${dependent.id}`),
    );
    expect(res!.status).toBe(200);
    const patched = await res!.json();
    expect(patched.blockedByTaskId).toBe(blocker.id);

    const row = db.prepare("SELECT blocked_by_task_id FROM tasks WHERE id = ?").get(dependent.id) as any;
    expect(row.blocked_by_task_id).toBe(blocker.id);
  });
});
