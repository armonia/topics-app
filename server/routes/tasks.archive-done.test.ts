/**
 * ARCHIVING A DONE CARD DOES NOT REOPEN IT (card 47b63de2).
 *
 * Archiving 2939 closed cards, 49 went from done back to backlog with a false
 * comment ("archived by you while the agent was working: turn interrupted"). The
 * DELETE detached the agent even from cards with no turn: `cutLiveTurn`
 * answered true just because the card still had an `assigned_topic_id`, and
 * `release` put it back in backlog.
 *
 * @covers KANBAN-07
 */
import { describe, expect, test } from "bun:test";
import { createTasksRouter } from "./tasks";
import { freshDb, makeCtx, call } from "./tasks-test-support";

async function closedCard(status: string, dispatchState: string | null = null) {
  const db = freshDb();
  const aborted: string[] = [];
  const fake = { onEnterTodo() {}, onLeaveTodo() {}, resume: async () => {} } as any;
  const r = createTasksRouter(makeCtx(db, []), fake, {
    abortTurn: async (sk: string) => { aborted.push(sk); },
    killAgentTree: async (sk: string) => { aborted.push(sk); },
  });
  db.run(`INSERT INTO topics (id) VALUES ('top-old')`);
  const t = await (await call(r, "POST", "/api/boards/pX/tasks", { text: "closed months ago" }))!.json();
  // The topic stays bound to the card after closing, but no turn runs any more.
  db.prepare("UPDATE tasks SET status = ?, assigned_topic_id = 'top-old', dispatch_state = ? WHERE id = ?").run(status, dispatchState, t.id);
  return { db, r, id: t.id as string, aborted };
}

describe("archiving a card that has no live turn", () => {
  test("a done card keeps its status and gets no comment", async () => {
    const c = await closedCard("done");
    const before = (c.db.prepare("SELECT COUNT(*) AS n FROM task_comments WHERE task_id = ?").get(c.id) as any).n;
    expect((await call(c.r, "DELETE", `/api/boards/pX/tasks/${c.id}`))!.status).toBe(200);
    const row = c.db.prepare("SELECT status, dispatch_state FROM tasks WHERE id = ?").get(c.id) as any;
    expect(row.status).toBe("done");
    expect(row.dispatch_state).toBeNull();
    const after = (c.db.prepare("SELECT COUNT(*) AS n FROM task_comments WHERE task_id = ?").get(c.id) as any).n;
    expect(after).toBe(before);
    expect(c.aborted).toEqual([]);
  });

  test("a card with a leftover topic but no turn is not detached either", async () => {
    const c = await closedCard("in_progress");
    expect((await call(c.r, "DELETE", `/api/boards/pX/tasks/${c.id}`))!.status).toBe(200);
    const row = c.db.prepare("SELECT status FROM tasks WHERE id = ?").get(c.id) as any;
    expect(row.status).toBe("in_progress");
    expect(c.aborted).toEqual([]);
  });

  test("a done card is never detached, even with a stale working chip", async () => {
    const c = await closedCard("done", "working");
    expect((await call(c.r, "DELETE", `/api/boards/pX/tasks/${c.id}`))!.status).toBe(200);
    const row = c.db.prepare("SELECT status FROM tasks WHERE id = ?").get(c.id) as any;
    expect(row.status).toBe("done");
    expect(c.aborted).toEqual([]);
  });
});
