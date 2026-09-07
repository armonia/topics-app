/**
 * A CARD ASKS FOR ITS CHILDREN, NOT FOR THE THREAD.
 *
 * Measured on the live board on 2026-09-07 (GET only): mounting the board cost
 * 25 requests for 1.122.652 B, of which 664.282 were comments. A card with
 * subtasks needs the children to draw «n/m» and the work chips; the window of
 * comments it renders already travels on the list row. So the whole thread was
 * bytes downloaded to be discarded, once per card AND once more on every
 * `updatedAt` bump, which is every single comment an agent writes.
 *
 * `?fields=children` answers the children alone. They stay WHOLE tasks: the
 * chips read `subtaskWork` and `queueReason`, and a reduced {id,text,status}
 * would silently blank them.
 * @covers WIRE-09
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createTasksRouter } from "./tasks";
import { freshDb, makeCtx, call } from "./tasks-test-support";

const BOARD = "board-one";
const ROOT = "t-root";
/** A comment as fat as the ones on the live board, times twenty. */
const COMMENT = "c".repeat(5000);
const COMMENTS = 20;
/** The ceiling the card has to stay under: the children of a real root. */
const CHILDREN_BUDGET = 20 * 1024;

describe("GET /api/boards/:b/tasks/:id?fields=children", () => {
  let db: Database; let router: ReturnType<typeof createTasksRouter>;
  beforeEach(() => {
    db = freshDb();
    router = createTasksRouter(makeCtx(db, []));
    db.run("INSERT INTO topics (id) VALUES ('topic-1')");
    db.run(
      `INSERT INTO tasks (id, project_id, text, status, priority, kanban_order, created_at, updated_at, assigned_topic_id)
       VALUES (?, ?, 'the root', 'in_progress', 2, 1, '2026-09-01T10:00:00.000Z', '2026-09-01T10:00:00.000Z', 'topic-1')`,
      [ROOT, BOARD],
    );
    for (let i = 0; i < 3; i++) {
      db.run(
        `INSERT INTO tasks (id, project_id, text, status, priority, kanban_order, created_at, updated_at, parent_task_id)
         VALUES (?, ?, ?, ?, 2, ?, '2026-09-01T10:00:00.000Z', '2026-09-01T10:00:00.000Z', ?)`,
        [`t-kid-${i}`, BOARD, `step ${i}`, i === 0 ? "in_progress" : "todo", i + 2, ROOT],
      );
    }
    for (let k = 0; k < COMMENTS; k++) {
      db.run(
        "INSERT INTO task_comments (id, task_id, author, content, created_at, kind) VALUES (?, ?, 'claude', ?, ?, 'comment')",
        [`c-${k}`, ROOT, COMMENT, `2026-09-01T11:${String(k).padStart(2, "0")}:00.000Z`],
      );
    }
  });

  test("answers the children alone: no thread, no task row", async () => {
    const resp = (await call(router, "GET", `/api/boards/${BOARD}/tasks/${ROOT}?fields=children`))!;
    expect(resp.status).toBe(200);
    const body = await resp.text();
    const parsed = JSON.parse(body) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["children"]);
    expect(body).not.toContain(COMMENT.slice(0, 200));
    expect(body.length).toBeLessThanOrEqual(CHILDREN_BUDGET);
  });

  test("the children are whole tasks, work chip included", async () => {
    const resp = (await call(router, "GET", `/api/boards/${BOARD}/tasks/${ROOT}?fields=children`))!;
    const { children } = (await resp.json()) as { children: Array<Record<string, unknown>> };
    expect(children).toHaveLength(3);
    const kid = children.find((c) => c.id === "t-kid-0")!;
    // The two fields the card reads to draw its chips.
    expect(kid).toHaveProperty("subtaskWork");
    expect(kid.subtaskWork).toBeTruthy();
    expect(kid).toHaveProperty("queueReason");
    // And the ordinary shape of a row, not a reduced projection.
    expect(kid.text).toBe("step 0");
    expect(kid.status).toBe("in_progress");
    expect(kid.parentTaskId).toBe(ROOT);
  });

  test("THE MIRROR: without the parameter the body is the whole thing, as before", async () => {
    const resp = (await call(router, "GET", `/api/boards/${BOARD}/tasks/${ROOT}`))!;
    const body = await resp.text();
    const parsed = JSON.parse(body) as { task: unknown; comments: unknown[]; children: unknown[] };
    expect(parsed.task).toBeTruthy();
    expect(parsed.comments).toHaveLength(COMMENTS);
    expect(parsed.children).toHaveLength(3);
    // The size the card was paying: two orders above the children alone.
    expect(body.length).toBeGreaterThan(100 * 1024);
  });

  test("an unknown fields value is not a silent filter: the whole body comes back", async () => {
    const resp = (await call(router, "GET", `/api/boards/${BOARD}/tasks/${ROOT}?fields=nope`))!;
    const parsed = (await resp.json()) as { comments: unknown[] };
    expect(parsed.comments).toHaveLength(COMMENTS);
  });
});
