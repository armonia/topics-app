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

function setup(withNode = false) {
  const db = freshDb(); const resumed: string[] = [];
  const dispatcher = {
    onEnterTodo() {}, onLeaveTodo() {}, onBlockerDone() {},
    resume: async (id: string) => { resumed.push(id); },
  } as any;
  const ctx: any = makeCtx(db, []);
  if (withNode) {
    ctx.machineStore = {
      upsertLocal: () => ({ id: "here" }),
      get: (id: string) => (id === "node-1" ? { baseUrl: "http://node.test" } : null),
    };
  }
  const router = createTasksRouter(ctx, dispatcher);
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

  test("archived card delivered by a node: the comment does not send it back to todo", async () => {
    const { db, router, reviewCard, row } = setup(true);
    const id = await reviewCard();
    db.run("INSERT INTO machines VALUES ('node-1','Node','http://node.test')");
    db.prepare("UPDATE tasks SET machine_id = 'node-1' WHERE id = ?").run(id);
    await call(router, "DELETE", `/api/boards/pX/tasks/${id}`);
    const resp = (await call(router, "POST", `/api/boards/pX/tasks/${id}/comments`, { content: "nota" }))!;
    expect((await resp.json()).delivery).toBe("note");
    expect(row(id).status).toBe("review");
  });
});

describe("a card closed by its owner", () => {
  async function closedCard() {
    const { db, router } = setup();
    const t = await (await call(router, "POST", "/api/boards/pX/tasks", { text: "chiusa" }))!.json();
    db.prepare("UPDATE tasks SET status = 'done', done_actor = 'human' WHERE id = ?").run(t.id);
    const status = () => (db.query("SELECT status FROM tasks WHERE id = ?").get(t.id) as { status: string }).status;
    return { router, id: t.id as string, status };
  }

  test("a script PATCHing it out of done is refused", async () => {
    const { router, id, status } = await closedCard();
    const resp = (await call(router, "PATCH", `/api/boards/pX/tasks/${id}`, { status: "backlog" }))!;
    expect(resp.status).toBe(409);
    expect((await resp.json()).code).toBe("closed_by_owner");
    expect(status()).toBe("done");
  });

  test("a click in the interface, or a script that says it is deliberate, reopens it", async () => {
    const a = await closedCard();
    const viaUi = (await call(a.router, "PATCH", `/api/boards/pX/tasks/${a.id}`, { status: "backlog" }, { "X-Topics-Action-Origin": "interface" }))!;
    expect(viaUi.status).toBe(200);
    expect(a.status()).toBe("backlog");
    const b = await closedCard();
    const sure = (await call(b.router, "PATCH", `/api/boards/pX/tasks/${b.id}`, { status: "backlog" }, { "X-Topics-Confirm-Reopen": "1" }))!;
    expect(sure.status).toBe(200);
    expect(b.status()).toBe("backlog");
  });
});
