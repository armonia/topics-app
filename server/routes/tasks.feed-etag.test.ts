/**
 * The global feed answers 304 when the client already holds it.
 *
 * The desktop app re-read `GET /api/all-boards/tasks` every 5 s for days with
 * no card moving (720 reads an hour of ~155 KB, server log 13-14/10). With an
 * ETag an unchanged feed costs an empty 304 instead of a body the webview
 * parses and diffs to arrive at the same rows.
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createTasksRouter } from "./tasks";
import { freshDb, makeCtx, call } from "./tasks-test-support";

const AT = "2026-10-14T10:00:00.000Z";

describe("GET /api/all-boards/tasks revalidation", () => {
  let db: Database;
  let router: ReturnType<typeof createTasksRouter>;

  beforeEach(() => {
    db = freshDb();
    router = createTasksRouter(makeCtx(db, []));
    db.run(
      `INSERT INTO tasks (id, project_id, text, status, priority, kanban_order, created_at, updated_at)
       VALUES ('t1', 'board-one', 'first card', 'todo', 2, 1, ?, ?)`,
      [AT, AT],
    );
  });

  test("a 200 carries an ETag, and sending it back gets an empty 304", async () => {
    const first = (await call(router, "GET", "/api/all-boards/tasks"))!;
    expect(first.status).toBe(200);
    const etag = first.headers.get("ETag");
    expect(etag).toBeTruthy();
    expect(((await first.json()) as { tasks: unknown[] }).tasks.length).toBe(1);

    const again = (await call(router, "GET", "/api/all-boards/tasks", undefined, { "If-None-Match": etag! }))!;
    expect(again.status).toBe(304);
    expect(again.headers.get("ETag")).toBe(etag);
    expect(await again.text()).toBe("");
  });

  test("a change to the board invalidates the old ETag", async () => {
    const first = (await call(router, "GET", "/api/all-boards/tasks"))!;
    const etag = first.headers.get("ETag")!;
    db.run("UPDATE tasks SET text = 'renamed card', updated_at = ? WHERE id = 't1'", ["2026-10-14T10:05:00.000Z"]);

    const after = (await call(router, "GET", "/api/all-boards/tasks", undefined, { "If-None-Match": etag }))!;
    expect(after.status).toBe(200);
    expect(after.headers.get("ETag")).not.toBe(etag);
    const body = (await after.json()) as { tasks: { text: string }[] };
    expect(body.tasks[0]!.text).toBe("renamed card");
  });

  test("the answer stays out of the HTTP cache", async () => {
    const res = (await call(router, "GET", "/api/all-boards/tasks"))!;
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
