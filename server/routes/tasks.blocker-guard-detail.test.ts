/**
 * THE REFUSAL TO ARCHIVE SAYS WHICH CARD IS WAITING, AND WHERE.
 *
 * Review feedback 26/11, the points left open:
 *  - the 409 said how MANY cards were waiting, not WHICH: with a deep subtree
 *    the blocker is usually a descendant of the card clicked, and a dependent
 *    can live on ANOTHER board (the waiting counter resolves those on purpose,
 *    `tasks.test.ts`), so the message carries the card, its board when it is
 *    not this one, and the descendant it waits on.
 *  - a card whose open children are UNHOOKED rather than archived (the board
 *    DELETE without `?withChildren=1`) was refused for a dependent of one of
 *    those children: a blocker that is not going anywhere made the card
 *    impossible to archive.
 *  - a dependent sitting under an ALREADY archived ancestor keeps `archived =
 *    0` while being invisible on the board: counting it as live made its
 *    blocker's ancestor impossible to archive, with nothing on screen to act
 *    on.
 */
import { describe, expect, test } from "bun:test";
import { createTasksRouter } from "./tasks";
import { freshDb, makeCtx, call } from "./tasks-test-support";

function router(db: ReturnType<typeof freshDb>) {
  const fake = { onEnterTodo() {}, onLeaveTodo() {}, resume: async () => {} } as any;
  return createTasksRouter(makeCtx(db, []), fake, { hasLiveTurn: () => false });
}

describe("a dependent on another board", () => {
  test("blocks the archive, and the refusal says on which board it is", async () => {
    const db = freshDb();
    const r = router(db);
    const blocker = await (await call(r, "POST", "/api/boards/pX/tasks", { text: "blocker" }))!.json();
    const far = await (await call(r, "POST", "/api/boards/pOther/tasks", { text: "ship the client update", blockedByTaskId: blocker.id }))!.json();

    const res = await call(r, "DELETE", `/api/boards/pX/tasks/${blocker.id}`);
    expect(res!.status).toBe(409);
    const body = await res!.json();
    expect(body.error).toContain(far.id);
    // The card is not on the board the person is looking at: the message says so.
    expect(body.error).toContain("pOther");
  });

  test("a dependent on the same board is named without a board", async () => {
    const db = freshDb();
    const r = router(db);
    const blocker = await (await call(r, "POST", "/api/boards/pX/tasks", { text: "blocker" }))!.json();
    await call(r, "POST", "/api/boards/pX/tasks", { text: "near dependent", blockedByTaskId: blocker.id });

    const res = await call(r, "DELETE", `/api/boards/pX/tasks/${blocker.id}`);
    expect(res!.status).toBe(409);
    expect((await res!.json()).error).not.toContain("on board");
  });
});

describe("the refusal to archive", () => {
  test("names the waiting card and the descendant it waits on", async () => {
    const db = freshDb();
    const r = router(db);
    const root = await (await call(r, "POST", "/api/boards/pX/tasks", { text: "root" }))!.json();
    const step = await (await call(r, "POST", "/api/boards/pX/tasks", { text: "step one", parentTaskId: root.id }))!.json();
    const waiting = await (await call(r, "POST", "/api/boards/pX/tasks", { text: "publish the release notes", blockedByTaskId: step.id }))!.json();

    const res = await call(r, "DELETE", `/api/boards/pX/tasks/${root.id}?withChildren=1`);
    expect(res!.status).toBe(409);
    const body = await res!.json();
    expect(body.code).toBe("blocks_live_dependent");
    // WHICH card is waiting, by title and by id.
    expect(body.error).toContain("publish the release notes");
    expect(body.error).toContain(waiting.id);
    // And which card inside the subtree it is actually waiting on.
    expect(body.error).toContain(step.id);
  });
});

describe("a DELETE that unhooks the open children instead of archiving them", () => {
  test("is not refused for a dependent of a child that stays on the board", async () => {
    const db = freshDb();
    const r = router(db);
    const root = await (await call(r, "POST", "/api/boards/pX/tasks", { text: "grouping card" }))!.json();
    const step = await (await call(r, "POST", "/api/boards/pX/tasks", { text: "step one", parentTaskId: root.id }))!.json();
    const waiting = await (await call(r, "POST", "/api/boards/pX/tasks", { text: "publish the release notes", blockedByTaskId: step.id }))!.json();

    const res = await call(r, "DELETE", `/api/boards/pX/tasks/${root.id}`);
    expect(res!.status).toBe(200);
    // The blocker is not going anywhere: unhooked, still open, still blocking.
    const stepRow = db.prepare("SELECT archived, parent_task_id FROM tasks WHERE id = ?").get(step.id) as any;
    expect(stepRow.archived).toBe(0);
    expect(stepRow.parent_task_id).toBe(null);
    const waitingRow = db.prepare("SELECT archived, blocked_by_task_id FROM tasks WHERE id = ?").get(waiting.id) as any;
    expect(waitingRow.archived).toBe(0);
    expect(waitingRow.blocked_by_task_id).toBe(step.id);
  });

  test("is still refused when the blocker is a child that DOES go down (a done step with a reopened grandchild)", async () => {
    const db = freshDb();
    const r = router(db);
    const root = await (await call(r, "POST", "/api/boards/pX/tasks", { text: "grouping card" }))!.json();
    const step = await (await call(r, "POST", "/api/boards/pX/tasks", { text: "step one", parentTaskId: root.id }))!.json();
    const grandchild = await (await call(r, "POST", "/api/boards/pX/tasks", { text: "reopened step", parentTaskId: step.id }))!.json();
    await call(r, "POST", "/api/boards/pX/tasks", { text: "publish the release notes", blockedByTaskId: grandchild.id });
    // A `done` child is not unhooked: it archives with the card, and so does
    // the still open grandchild under it.
    db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(step.id);

    const res = await call(r, "DELETE", `/api/boards/pX/tasks/${root.id}`);
    expect(res!.status).toBe(409);
    expect((db.prepare("SELECT archived FROM tasks WHERE id = ?").get(root.id) as any).archived).toBe(0);
  });
});

describe("a dependent under an already archived ancestor", () => {
  test("does not keep its blocker's ancestor from being archived", async () => {
    const db = freshDb();
    const r = router(db);
    const root = await (await call(r, "POST", "/api/boards/pX/tasks", { text: "root" }))!.json();
    const step = await (await call(r, "POST", "/api/boards/pX/tasks", { text: "step one", parentTaskId: root.id }))!.json();
    const dead = await (await call(r, "POST", "/api/boards/pX/tasks", { text: "an abandoned branch of work" }))!.json();
    const ghost = await (await call(r, "POST", "/api/boards/pX/tasks", { text: "step of the abandoned branch", parentTaskId: dead.id, blockedByTaskId: step.id }))!.json();
    // The ancestor was archived; the child row was reopened afterwards, so it
    // is off the board but still `archived = 0`.
    db.prepare("UPDATE tasks SET archived = 1 WHERE id = ?").run(dead.id);
    db.prepare("UPDATE tasks SET archived = 0, status = 'todo' WHERE id = ?").run(ghost.id);

    const res = await call(r, "DELETE", `/api/boards/pX/tasks/${root.id}?withChildren=1`);
    expect(res!.status).toBe(200);
    expect((db.prepare("SELECT archived FROM tasks WHERE id = ?").get(step.id) as any).archived).toBe(1);
  });

  test("but a dependent under a live parent still blocks it", async () => {
    const db = freshDb();
    const r = router(db);
    const root = await (await call(r, "POST", "/api/boards/pX/tasks", { text: "root" }))!.json();
    const step = await (await call(r, "POST", "/api/boards/pX/tasks", { text: "step one", parentTaskId: root.id }))!.json();
    const alive = await (await call(r, "POST", "/api/boards/pX/tasks", { text: "parent still open" }))!.json();
    await call(r, "POST", "/api/boards/pX/tasks", { text: "waiting step", parentTaskId: alive.id, blockedByTaskId: step.id });

    const res = await call(r, "DELETE", `/api/boards/pX/tasks/${root.id}?withChildren=1`);
    expect(res!.status).toBe(409);
  });
});
