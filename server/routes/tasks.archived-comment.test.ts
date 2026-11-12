/**
 * A COMMENT ON AN ARCHIVED CARD IS A NOTE, NEVER A RESTART.
 *
 * `archive()` leaves the status alone, so a card archived out of review keeps
 * `review` and its agent topic. The comments route used to look only at status
 * and topic: a message on it rejected the card back to in_progress and woke the
 * agent on a card that had left the board. The other test here pins the
 * neighbouring truth the composer button now states: on a card whose agent ran
 * out of turns the message DOES restart the agent.
 *
 * @covers REVIEW-BUTTONS-01
 */
import { test, expect, describe } from "bun:test";
import { createTasksRouter } from "./tasks";
import { freshDb, makeCtx, call } from "./tasks-test-support";

function setup() {
  const db = freshDb(); const resumed: string[] = [];
  const dispatcher = {
    onEnterTodo() {}, onLeaveTodo() {}, onBlockerDone() {},
    resume: async (id: string) => { resumed.push(id); },
  } as any;
  const router = createTasksRouter(makeCtx(db, []), dispatcher);
  async function reviewCard(): Promise<string> {
    db.run("INSERT INTO topics (id) VALUES ('top-1')");
    const t = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "studio" }))!.json();
    db.prepare("UPDATE tasks SET assigned_topic_id = 'top-1', status = 'review' WHERE id = ?").run(t.id);
    return t.id;
  }
  const row = (id: string) => db.query("SELECT status, archived FROM tasks WHERE id = ?").get(id) as { status: string; archived: number };
  return { db, router, resumed, reviewCard, row };
}

describe("comments on a review card", () => {
  test("archived: saved as a note, the card stays put and the agent is not restarted", async () => {
    const { router, resumed, reviewCard, row } = setup();
    const id = await reviewCard();
    await call(router, "DELETE", `/api/boards/pX/tasks/${id}`);
    expect(row(id).archived).toBeTruthy();
    const resp = (await call(router, "POST", `/api/boards/pX/tasks/${id}/comments`, { content: "ancora una cosa" }))!;
    expect(resp.status).toBe(201);
    expect((await resp.json()).delivery).toBe("note");
    expect(row(id).status).toBe("review");
    expect(resumed).toEqual([]);
  });

  test("agent out of turns (retries exhausted): the message really restarts the agent", async () => {
    const { db, router, resumed, reviewCard, row } = setup();
    const id = await reviewCard();
    db.prepare("UPDATE tasks SET delivered_by = 'system', delivered_reason = 'retries_exhausted' WHERE id = ?").run(id);
    const resp = (await call(router, "POST", `/api/boards/pX/tasks/${id}/comments`, { content: "riprova" }))!;
    expect((await resp.json()).delivery).toBe("queued");
    expect(row(id).status).toBe("in_progress");
    expect(resumed).toEqual([id]);
  });
});
