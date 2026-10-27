/**
 * AN ARCHIVED CARD PUT BACK TO DONE KEEPS ITS CLOSING DATE (card 600feca6).
 *
 * The bug fixed in #471 sent 49 done cards back to backlog while they were
 * being archived. `release` left `completed_at` alone, but the PATCH that put
 * them back in done stamped them closed today (a22b3191: 2026-07-14 became
 * 2026-10-26), and `completedAt` was refused as read-only.
 *
 * @covers KANBAN-07
 */
import { describe, expect, test } from "bun:test";
import { createTasksRouter } from "./tasks";
import { freshDb, makeCtx, call } from "./tasks-test-support";

const CLOSED = "2026-07-14T09:12:33.456Z";

async function card(opts: { status: string; completedAt: string | null; archived: boolean }) {
  const db = freshDb();
  const fake = { onEnterTodo() {}, onLeaveTodo() {}, onBlockerDone() {}, resume: async () => {} } as any;
  const r = createTasksRouter(makeCtx(db, []), fake);
  const t = await (await call(r, "POST", "/api/boards/pX/tasks", { text: "closed in July" }))!.json();
  db.prepare("UPDATE tasks SET status = ?, completed_at = ?, archived = ? WHERE id = ?")
    .run(opts.status, opts.completedAt, opts.archived ? 1 : 0, t.id);
  const read = () => db.prepare("SELECT status, completed_at FROM tasks WHERE id = ?").get(t.id) as any;
  const patch = (body: unknown) => call(r, "PATCH", `/api/boards/pX/tasks/${t.id}`, body);
  return { read, patch };
}

describe("putting an archived card back to done", () => {
  test("keeps the completed_at it already had", async () => {
    const c = await card({ status: "backlog", completedAt: CLOSED, archived: true });
    expect((await c.patch({ status: "done" }))!.status).toBe(200);
    expect(c.read()).toEqual({ status: "done", completed_at: CLOSED });
  });

  test("a second PATCH done on an archived done card leaves the date intact", async () => {
    const c = await card({ status: "done", completedAt: CLOSED, archived: true });
    expect((await c.patch({ status: "done" }))!.status).toBe(200);
    expect(c.read().completed_at).toBe(CLOSED);
  });

  test("an archived card with no date gets one", async () => {
    const c = await card({ status: "backlog", completedAt: null, archived: true });
    expect((await c.patch({ status: "done" }))!.status).toBe(200);
    expect(c.read().completed_at).not.toBeNull();
  });

  test("completedAt repairs a date already overwritten", async () => {
    const c = await card({ status: "done", completedAt: "2026-10-26T19:43:00.000Z", archived: true });
    expect((await c.patch({ completedAt: CLOSED }))!.status).toBe(200);
    expect(c.read()).toEqual({ status: "done", completed_at: CLOSED });
  });

  test("completedAt rides along with status done", async () => {
    const c = await card({ status: "backlog", completedAt: null, archived: true });
    expect((await c.patch({ status: "done", completed_at: CLOSED }))!.status).toBe(200);
    expect(c.read()).toEqual({ status: "done", completed_at: CLOSED });
  });
});

describe("what does not change", () => {
  test("a live card moved to done is stamped now, whatever it carried", async () => {
    const c = await card({ status: "backlog", completedAt: CLOSED, archived: false });
    expect((await c.patch({ status: "done" }))!.status).toBe(200);
    expect(c.read().completed_at).not.toBe(CLOSED);
  });

  test("completedAt on a live card is a 400 and writes nothing", async () => {
    const c = await card({ status: "done", completedAt: "2026-10-26T19:43:00.000Z", archived: false });
    expect((await c.patch({ completedAt: CLOSED }))!.status).toBe(400);
    expect(c.read().completed_at).toBe("2026-10-26T19:43:00.000Z");
  });

  test("completedAt on an archived card that is not going to done is a 400", async () => {
    const c = await card({ status: "backlog", completedAt: CLOSED, archived: true });
    expect((await c.patch({ completedAt: CLOSED }))!.status).toBe(400);
    expect((await c.patch({ status: "todo", completedAt: CLOSED }))!.status).toBe(400);
    expect(c.read()).toEqual({ status: "backlog", completed_at: CLOSED });
  });

  test("a malformed or future date is a 400", async () => {
    const c = await card({ status: "done", completedAt: CLOSED, archived: true });
    for (const bad of ["2026-07-14", "14/07/2026", "2026-07-14T09:12:33+02:00", "2999-01-01T00:00:00.000Z", 1752484353]) {
      expect((await c.patch({ completedAt: bad }))!.status).toBe(400);
    }
    expect(c.read().completed_at).toBe(CLOSED);
  });
});
