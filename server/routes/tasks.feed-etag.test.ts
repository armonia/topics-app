/**
 * The global feed answers 304 when the client already holds it.
 *
 * Every open window re-reads `GET /api/all-boards/tasks` (~155 KB) on task
 * events, reconnects and returns to view, up to 70 times an hour (server log
 * 13-14/10). With an
 * ETag an unchanged feed costs an empty 304 instead of a body the webview
 * parses and diffs to arrive at the same rows.
 *
 * @covers KANBAN-98
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
    const tag = first.headers.get("ETag");
    expect(tag).toBeTruthy();
    expect(((await first.json()) as { tasks: unknown[] }).tasks.length).toBe(1);

    const again = (await call(router, "GET", "/api/all-boards/tasks", undefined, { "If-None-Match": tag! }))!;
    expect(again.status).toBe(304);
    expect(again.headers.get("ETag")).toBe(tag);
    expect(await again.text()).toBe("");
  });

  test("a change to the board invalidates the old ETag", async () => {
    const first = (await call(router, "GET", "/api/all-boards/tasks"))!;
    const tag = first.headers.get("ETag")!;
    db.run("UPDATE tasks SET text = 'renamed card', updated_at = ? WHERE id = 't1'", ["2026-10-14T10:05:00.000Z"]);

    const after = (await call(router, "GET", "/api/all-boards/tasks", undefined, { "If-None-Match": tag }))!;
    expect(after.status).toBe(200);
    expect(after.headers.get("ETag")).not.toBe(tag);
    const body = (await after.json()) as { tasks: { text: string }[] };
    expect(body.tasks[0]!.text).toBe("renamed card");
  });

  test("the answer stays out of the HTTP cache", async () => {
    const res = (await call(router, "GET", "/api/all-boards/tasks"))!;
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  test("the desktop shell can read the ETag: it reads cross-origin, so the header is exposed", async () => {
    // The shell's page is `tauri://localhost` and the API is 127.0.0.1:13333.
    // Without the exposure its fetch sees `ETag: null` and never revalidates.
    const res = (await call(router, "GET", "/api/all-boards/tasks"))!;
    const exposed = (res.headers.get("Access-Control-Expose-Headers") ?? "").split(",").map((h) => h.trim().toLowerCase());
    expect(exposed).toContain("etag");
  });
});
