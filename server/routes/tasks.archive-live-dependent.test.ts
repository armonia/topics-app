/**
 * ARCHIVING A LIVE BLOCKER MUST NOT DETACH FIRST AND REJECT AFTER.
 *
 * Review feedback 26/11, punto 1: `detachLiveAgent`/`cutLiveTurn` and
 * `detachOpenChildren` ran BEFORE `svc.archive`, which then threw
 * `blocks_live_dependent`. The DELETE answered 409, but the agent was
 * already killed and the open children already unhooked (`parent_task_id =
 * null`, with a false "staccata, archiviata" comment) — damage a 409 cannot
 * undo. `svc.assertArchivable` now runs first, with no side effect of its
 * own: this is red if that precheck is removed from the route and the old
 * order (detach, then archive) comes back.
 */
import { describe, expect, test } from "bun:test";
import { createTasksRouter } from "./tasks";
import { freshDb, makeCtx, call } from "./tasks-test-support";

describe("DELETE on a card that still blocks a live dependent", () => {
  test("rejects 409 and leaves the agent and the open child untouched", async () => {
    const db = freshDb();
    const aborted: string[] = [];
    const fake = { onEnterTodo() {}, onLeaveTodo() {}, resume: async () => {} } as any;
    const r = createTasksRouter(makeCtx(db, []), fake, {
      abortTurn: async (sk: string) => { aborted.push(sk); },
      killAgentTree: async (sk: string) => { aborted.push(sk); },
      hasLiveTurn: () => true,
    });
    db.run(`INSERT INTO topics (id) VALUES ('top-live')`);

    const blocker = await (await call(r, "POST", "/api/boards/pX/tasks", { text: "blocker" }))!.json();
    const child = await (await call(r, "POST", "/api/boards/pX/tasks", { text: "open child", parentTaskId: blocker.id }))!.json();
    const dependent = await (await call(r, "POST", "/api/boards/pX/tasks", { text: "dependent", blockedByTaskId: blocker.id }))!.json();
    // Give the blocker a live agent, exactly the state `detachLiveAgent` tears down.
    db.prepare("UPDATE tasks SET assigned_topic_id = 'top-live', dispatch_state = 'working' WHERE id = ?").run(blocker.id);

    const res = await call(r, "DELETE", `/api/boards/pX/tasks/${blocker.id}`);
    expect(res!.status).toBe(409);

    const row = db.prepare(
      "SELECT archived, assigned_topic_id, dispatch_state FROM tasks WHERE id = ?",
    ).get(blocker.id) as any;
    expect(row.archived).toBe(0);
    // The precheck never reached `detachLiveAgent`/`cutLiveTurn`: the agent stays wired.
    expect(row.assigned_topic_id).toBe("top-live");
    expect(row.dispatch_state).toBe("working");
    expect(aborted).toEqual([]);
    // The precheck never reached `detachOpenChildren` either: the child keeps its parent.
    const childRow = db.prepare("SELECT parent_task_id, archived FROM tasks WHERE id = ?").get(child.id) as any;
    expect(childRow.parent_task_id).toBe(blocker.id);
    expect(childRow.archived).toBe(0);
    // And the dependent is, correctly, still waiting on a live blocker.
    expect((db.prepare("SELECT archived FROM tasks WHERE id = ?").get(dependent.id) as any).archived).toBe(0);
  });
});
