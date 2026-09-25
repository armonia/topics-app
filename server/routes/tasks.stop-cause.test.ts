/**
 * A CARD'S AGENT IS STOPPED BY SOMEBODY, AND THE STOP SAYS WHO (card C9).
 *
 * The cause reaches `/api/chat/abort`, and a `user` there is written down as
 * the person's Stop, which the resume sweep honours after a restart. The board
 * has two doors a person uses (Stop, and archiving a card), and the server goes
 * through the second one itself when another machine revokes a delegated card
 * (`deleteDelegatedBoardTask` in server.ts). That one said `user` too, while
 * the dispatcher signs the same revocation `superseded`.
 *
 * @covers KANBAN-07
 */
import { describe, expect, test } from "bun:test";
import { createTasksRouter } from "./tasks";
import { freshDb, makeCtx, call } from "./tasks-test-support";
import { STOP_CAUSE_HEADER } from "../lib/abort-cause";

/** A board with one card whose agent is working, and the causes its stops carried. */
async function workingCard(topicId: string) {
  const db = freshDb();
  const causes: string[] = [];
  const fake = { onEnterTodo() {}, onLeaveTodo() {}, resume: async () => {} } as any;
  const r = createTasksRouter(makeCtx(db, []), fake, { abortTurn: async (_sk: string, cause: string) => { causes.push(cause); } });
  db.run(`INSERT INTO topics (id) VALUES ('${topicId}')`);
  const t = await (await call(r, "POST", "/api/boards/pX/tasks", { text: "al lavoro", status: "in_progress" }))!.json();
  db.prepare("UPDATE tasks SET assigned_topic_id = ?, dispatch_state = 'working' WHERE id = ?").run(topicId, t.id);
  return { r, id: t.id as string, causes };
}

describe("the stop of a card's agent says who stopped it", () => {
  test("the person's Stop on the card is theirs", async () => {
    const c = await workingCard("top-stop");
    expect((await call(c.r, "POST", `/api/boards/pX/tasks/${c.id}/stop`, {}))!.status).toBe(200);
    expect(c.causes).toEqual(["user"]);
  });

  test("the person archiving a card with its agent at work is theirs too", async () => {
    const c = await workingCard("top-arch");
    expect((await call(c.r, "DELETE", `/api/boards/pX/tasks/${c.id}`))!.status).toBe(200);
    expect(c.causes).toEqual(["user"]);
  });

  test("the DELETE the server sends for a revoked delegation is the machine's", async () => {
    const c = await workingCard("top-rev");
    const url = new URL(`http://localhost/api/boards/pX/tasks/${c.id}`);
    const resp = await c.r(new Request(url, { method: "DELETE", headers: { [STOP_CAUSE_HEADER]: "superseded" } }), url, url.pathname, "DELETE");
    expect(resp?.status).toBe(200);
    expect(c.causes).toEqual(["superseded"]);
  });
});
