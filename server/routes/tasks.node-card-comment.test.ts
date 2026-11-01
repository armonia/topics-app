/**
 * A comment on a card a NODE delivered must restart it, or say it did not.
 *
 * The run on the node is over by the time the card sits in review, so the
 * comment has no session to be handed to. The route used to save the note and
 * leave the card in review (the caller read "delivered" and nobody started).
 * Here a fake dispatcher stands in for the node lane and records the requeue.
 */
import { test, expect, describe, beforeEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTasksRouter } from "./tasks";
import { freshDb, makeCtx, call } from "./tasks-test-support";

function fakeDispatcher(entered: string[], resumed: string[]) {
  return {
    onEnterTodo(_project: string, taskId: string) { entered.push(taskId); },
    onLeaveTodo() { /* no-op */ },
    onBlockerDone() { /* no-op */ },
    resume: async (taskId: string) => { resumed.push(taskId); },
  } as never;
}

describe("comment on a review card delivered by a node", () => {
  let db: Database;
  let entered: string[];
  let resumed: string[];
  beforeEach(() => { db = freshDb(); entered = []; resumed = []; });

  const router = () =>
    createTasksRouter(makeCtx(db, []), fakeDispatcher(entered, resumed), { abortTurn: async () => { /* no-op */ } });

  async function nodeCardInReview(r: ReturnType<typeof router>) {
    const created = await (await call(r, "POST", "/api/boards/pX/tasks", { text: "remote work", status: "todo" }))!.json();
    db.prepare("INSERT OR IGNORE INTO machines (id, base_url) VALUES ('node-1', 'http://127.0.0.1:9443')").run();
    db.prepare("UPDATE tasks SET status = 'review', machine_id = 'node-1', assigned_topic_id = NULL WHERE id = ?").run(created.id);
    entered.length = 0; // creating it in todo already announced it
    return created.id as string;
  }

  test("the card goes back to todo, the node lane is told, and the answer says queued", async () => {
    const r = router();
    const id = await nodeCardInReview(r);
    const resp = (await call(r, "POST", `/api/boards/pX/tasks/${id}/comments`, { content: "yes, go ahead" }))!;
    expect(resp.status).toBe(201);
    expect((await resp.json()).delivery).toBe("queued");
    const after = await (await call(r, "GET", `/api/boards/pX/tasks/${id}`))!.json();
    expect(after.task.status).toBe("todo");
    expect(entered).toContain(id);
    // Never a local turn for a remote card.
    expect(resumed).toEqual([]);
  });

  test("a card that already landed stays in review: the comment is only a note", async () => {
    const r = router();
    const id = await nodeCardInReview(r);
    db.prepare("UPDATE tasks SET landing_state = 'landed' WHERE id = ?").run(id);
    const resp = (await call(r, "POST", `/api/boards/pX/tasks/${id}/comments`, { content: "thanks" }))!;
    expect((await resp.json()).delivery).toBe("note");
    const after = await (await call(r, "GET", `/api/boards/pX/tasks/${id}`))!.json();
    expect(after.task.status).toBe("review");
    expect(entered).toEqual([]);
  });
});
