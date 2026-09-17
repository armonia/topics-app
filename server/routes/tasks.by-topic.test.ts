/**
 * THE DOOR FROM A DEAD PANE BACK TO ITS CARD, exercised as a ROUTE.
 *
 * `taskIdOfTopic` has its own unit test and the overlay has its e2e, but
 * between the two the e2e stubs this very URL (`page.route("**\/by-topic/**")`
 * in tests/e2e/terminal-dormant-cause.spec.ts), so the handler itself was the
 * one link in the chain no test ever called: deleting the whole block from
 * `tasks.ts` left 167 route+service tests green while the cause line died in
 * production. Same family as [[project_route-gated-by-wrong-router]] — a route
 * that exists in the source is not a route that answers.
 *
 * @covers TERM-12
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createTasksRouter } from "./tasks";
import { freshDb, makeCtx, call } from "./tasks-test-support";

const BOARD = "board-one";
const AT = "2026-09-14T23:03:00.000Z";

describe("GET /api/all-boards/tasks/by-topic/:topicId", () => {
  let db: Database;
  let router: ReturnType<typeof createTasksRouter>;

  beforeEach(() => {
    db = freshDb();
    router = createTasksRouter(makeCtx(db, []));
    for (const id of ["topic-live", "topic-old", "topic-orphan"]) {
      db.run("INSERT INTO topics (id) VALUES (?)", [id]);
    }
  });

  function seedCard(id: string, topicId: string | null, interruptedAt?: string) {
    db.run(
      `INSERT INTO tasks (id, project_id, text, status, priority, kanban_order,
         created_at, updated_at, assigned_topic_id, interrupted_at)
       VALUES (?, ?, ?, 'in_progress', 2, 1, ?, ?, ?, ?)`,
      [id, BOARD, "card " + id, AT, AT, topicId, interruptedAt ?? null],
    );
  }

  test("answers the card bound to the topic — the route exists at runtime, not only in the source", async () => {
    seedCard("t-live", "topic-live", AT);
    const resp = (await call(router, "GET", "/api/all-boards/tasks/by-topic/topic-live"))!;
    expect(resp.status).toBe(200);
    const body = await resp.json() as { task?: { id?: string; interruptedAt?: string } | null };
    expect(body.task?.id).toBe("t-live");
    // The one field the pane reads to say WHEN the restart cut the turn: if it
    // were filtered out of the wire the overlay would fall back to silence.
    expect(body.task?.interruptedAt).toBe(AT);
  });

  test("falls back to the attempt history when the card has since moved to a new topic", async () => {
    seedCard("t-moved", "topic-live");
    db.run(
      `INSERT INTO task_attempts (id, task_id, idx, topic_id, state, created_at)
       VALUES ('a1', 't-moved', 1, 'topic-old', 'done', ?)`,
      [AT],
    );
    const resp = (await call(router, "GET", "/api/all-boards/tasks/by-topic/topic-old"))!;
    expect(resp.status).toBe(200);
    expect(((await resp.json()) as { task?: { id?: string } | null }).task?.id).toBe("t-moved");
  });

  test("a topic no card ever worked is 200 + task:null, not an error", async () => {
    const resp = (await call(router, "GET", "/api/all-boards/tasks/by-topic/topic-orphan"))!;
    expect(resp.status).toBe(200);
    expect(((await resp.json()) as { task?: unknown }).task).toBeNull();
  });

  test("the by-id door is NOT the one answering: a task literally named 'by-topic' does not shadow it", async () => {
    // `matchRoute` is length-strict, so the two patterns can never collide -
    // this pins that, because the block's own comment claims the opposite and
    // a future reader may reorder on the strength of it.
    seedCard("by-topic", null);
    const resp = (await call(router, "GET", "/api/all-boards/tasks/by-topic/topic-live"))!;
    expect(((await resp.json()) as { task?: { id?: string } | null }).task).toBeNull();
  });
});
