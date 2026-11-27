/**
 * @covers KANBAN-123
 *
 * ARCHIVING A LIVE BLOCKER MUST NOT DETACH FIRST AND REJECT AFTER.
 *
 * Review feedback 26/11, punto 1: `detachLiveAgent`/`cutLiveTurn` and
 * `detachOpenChildren` ran BEFORE `svc.archive`, which then threw
 * `blocks_live_dependent`. The DELETE answered 409, but the agent was
 * already killed and the open children already unhooked (`parent_task_id =
 * null`, with a false "staccata, archiviata" comment) — damage a 409 cannot
 * undo. `svc.assertArchivable` now runs first, with no side effect of its
 * own: this is red if that precheck is removed from the route and the old
 * order (detach, then archive) comes back. Two more cases from the same
 * review round: a dependent hanging off a CHILD, not the root, under
 * `?withChildren=1` (red if `detachingOpenChildren: !takesChildrenDown` is
 * hardcoded to `true`), and a DONE root whose own live stream must stay
 * wired when a child still blocks a dependent (the `cutLiveTurn` branch,
 * the route's other call site for the same precheck).
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

  // Review feedback 26/11, punto 1: the previous test's child has no live
  // agent of its own and the call carries no `?withChildren=1`, so a mutation
  // that hardcodes `detachingOpenChildren: true` in the route (forgetting
  // `takesChildrenDown`) would still pass it — the open child is pruned from
  // the precheck either way. `?withChildren=1` takes the WHOLE subtree down,
  // so a dependent on a child must block exactly as one on the root.
  test("?withChildren=1 still rejects when the live dependent hangs off a child, not the root", async () => {
    const db = freshDb();
    const aborted: string[] = [];
    const fake = { onEnterTodo() {}, onLeaveTodo() {}, resume: async () => {} } as any;
    const r = createTasksRouter(makeCtx(db, []), fake, {
      abortTurn: async (sk: string) => { aborted.push(sk); },
      killAgentTree: async (sk: string) => { aborted.push(sk); },
      hasLiveTurn: () => true,
    });
    db.run(`INSERT INTO topics (id) VALUES ('top-child-live')`);

    const root = await (await call(r, "POST", "/api/boards/pX/tasks", { text: "root" }))!.json();
    const child = await (await call(r, "POST", "/api/boards/pX/tasks", { text: "open child", parentTaskId: root.id }))!.json();
    const dependent = await (await call(r, "POST", "/api/boards/pX/tasks", { text: "dependent", blockedByTaskId: child.id }))!.json();
    db.prepare("UPDATE tasks SET assigned_topic_id = 'top-child-live', dispatch_state = 'working' WHERE id = ?").run(child.id);

    const res = await call(r, "DELETE", `/api/boards/pX/tasks/${root.id}?withChildren=1`);
    expect(res!.status).toBe(409);

    const rootRow = db.prepare("SELECT archived FROM tasks WHERE id = ?").get(root.id) as any;
    expect(rootRow.archived).toBe(0);
    const childRow = db.prepare("SELECT archived, assigned_topic_id, dispatch_state FROM tasks WHERE id = ?").get(child.id) as any;
    expect(childRow.archived).toBe(0);
    expect(childRow.assigned_topic_id).toBe("top-child-live");
    expect(aborted).toEqual([]);
    expect((db.prepare("SELECT archived FROM tasks WHERE id = ?").get(dependent.id) as any).archived).toBe(0);
    // The child never left the root's tree: no "Staccata da ..." note exists.
    const notes = db.prepare("SELECT content FROM task_comments WHERE task_id = ?").all(child.id) as Array<{ content: string }>;
    expect(notes.some((n) => n.content.includes("Staccata"))).toBe(false);
  });

  // "radice done con stream vivo" (review feedback 26/11, punto 1): the done
  // branch calls `cutLiveTurn` instead of `detachLiveAgent`, a second call
  // site the precheck must guard just as well. A child still blocking a
  // dependent must stop the DELETE before that root's own live stream is cut.
  test("a done root's live stream is not cut when ?withChildren=1 would take down a live blocker", async () => {
    const db = freshDb();
    const aborted: string[] = [];
    const fake = { onEnterTodo() {}, onLeaveTodo() {}, resume: async () => {} } as any;
    const r = createTasksRouter(makeCtx(db, []), fake, {
      abortTurn: async (sk: string) => { aborted.push(sk); },
      killAgentTree: async (sk: string) => { aborted.push(sk); },
      hasLiveTurn: () => true,
    });
    db.run(`INSERT INTO topics (id) VALUES ('top-root-done-live')`);

    const root = await (await call(r, "POST", "/api/boards/pX/tasks", { text: "done root" }))!.json();
    const child = await (await call(r, "POST", "/api/boards/pX/tasks", { text: "open child", parentTaskId: root.id }))!.json();
    const dependent = await (await call(r, "POST", "/api/boards/pX/tasks", { text: "dependent", blockedByTaskId: child.id }))!.json();
    db.prepare("UPDATE tasks SET status = 'done', assigned_topic_id = 'top-root-done-live' WHERE id = ?").run(root.id);

    const res = await call(r, "DELETE", `/api/boards/pX/tasks/${root.id}?withChildren=1`);
    expect(res!.status).toBe(409);

    const rootRow = db.prepare("SELECT archived, assigned_topic_id FROM tasks WHERE id = ?").get(root.id) as any;
    expect(rootRow.archived).toBe(0);
    expect(rootRow.assigned_topic_id).toBe("top-root-done-live");
    // The precheck ran before `cutLiveTurn`: the done root's own stream stays wired.
    expect(aborted).toEqual([]);
    expect((db.prepare("SELECT archived FROM tasks WHERE id = ?").get(dependent.id) as any).archived).toBe(0);
  });
});
