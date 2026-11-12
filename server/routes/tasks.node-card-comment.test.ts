/**
 * A human comment on a card in review that a NODE delivered. The run on the
 * node is already closed, so reject+resume restarted nobody while the answer
 * said «queued» (card 6290d85d). Such a card goes back to todo, where the node
 * launches it again with the thread; a card on this Mac keeps the old path.
 *
 * @covers KANBAN-76
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import type { AppContext, RouteHandler } from "../types";
import { EMBEDDED_MIGRATIONS } from "../db/migrations-embedded";
import { createMachineStore } from "../services/machine-store";
import { createTasksRouter } from "./tasks";
import { call, makeCtx } from "./tasks-test-support";

const BOARD = "node-board-abc123";

describe("comment on a card in review", () => {
  let db: Database; let nodeId: string; let localId: string;
  let entered: Array<[string, string]>; let resumed: string[]; let router: RouteHandler;
  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    for (const m of EMBEDDED_MIGRATIONS) db.run(m.sql);
    const machines = createMachineStore(db, process.cwd());
    nodeId = machines.upsertNode({ hostname: "pc:3333", name: "PC", baseUrl: "http://127.0.0.1:9443" }).id;
    localId = machines.upsertLocal().id;
    db.run("INSERT INTO topics (id, name, slug, session_key, created_at, updated_at) VALUES ('top-x', 'x', 'x', 'sk-x', 'now', 'now')");
    entered = []; resumed = [];
    const fakeDispatcher = {
      onEnterTodo: (pid: string, tid: string) => entered.push([pid, tid]),
      onLeaveTodo() {},
      resume: async (id: string) => { resumed.push(id); },
    } as any;
    const ctx = Object.assign(makeCtx(db, []), { machineStore: machines }) as unknown as AppContext;
    router = createTasksRouter(ctx, fakeDispatcher);
  });

  async function cardInReview(machineId: string): Promise<string> {
    const t = await (await call(router, "POST", `/api/boards/${BOARD}/tasks`, { text: "deliver", status: "in_progress", machineId }))!.json();
    db.prepare("UPDATE tasks SET assigned_topic_id = 'top-x' WHERE id = ?").run(t.id);
    await call(router, "PATCH", `/api/boards/${BOARD}/tasks/${t.id}`, { status: "review" });
    // The PATCH above moves status as a human action, which never opens a
    // pending review approval (only an agent delivery does) — a real card in
    // review always has one, so the fixture opens it by hand.
    db.prepare(
      `INSERT INTO approvals (id, task_id, requested_by, approval_type, from_status, to_status, status, created_at)
       VALUES (?, ?, 'agent', 'review', 'in_progress', 'done', 'pending', 'now')`,
    ).run(`appr-${t.id}`, t.id);
    return t.id;
  }
  const statusOf = (id: string) => (db.query("SELECT status FROM tasks WHERE id = ?").get(id) as { status: string }).status;

  test("a card delivered by a node goes back to todo and the node launches it again", async () => {
    const id = await cardInReview(nodeId);
    const resp = (await call(router, "POST", `/api/boards/${BOARD}/tasks/${id}/comments`, { content: "rispondo alla tua domanda" }))!;
    expect(resp.status).toBe(201);
    expect((await resp.json()).delivery).toBe("queued");
    expect(statusOf(id)).toBe("todo");
    expect(entered).toEqual([[BOARD, id]]);
    expect(resumed).toEqual([]);
  });

  test("a card on this Mac (its own machine row is the default «here») keeps reject+resume", async () => {
    const id = await cardInReview(localId);
    const resp = (await call(router, "POST", `/api/boards/${BOARD}/tasks/${id}/comments`, { content: "continua" }))!;
    expect((await resp.json()).delivery).toBe("queued");
    expect(statusOf(id)).toBe("in_progress");
    expect(resumed).toEqual([id]);
    expect(entered).toEqual([]);
  });

  const approvalStatusOf = (id: string) =>
    (db.query("SELECT status FROM approvals WHERE task_id = ? AND approval_type = 'review'").get(id) as { status: string } | null)?.status;

  test("a comment's reject on a root closes the pending approval 'rejected', like an explicit board_review reject", async () => {
    const id = await cardInReview(localId);
    await call(router, "POST", `/api/boards/${BOARD}/tasks/${id}/comments`, { content: "continua" });
    expect(approvalStatusOf(id)).toBe("rejected");
  });

  test("a node card requeued by a comment also gets FRESH_SESSION_NOTE and a 'rejected' approval, same as board_review reject", async () => {
    const id = await cardInReview(nodeId);
    const before = (await (await call(router, "GET", `/api/boards/${BOARD}/tasks/${id}`))!.json()).comments.length;
    await call(router, "POST", `/api/boards/${BOARD}/tasks/${id}/comments`, { content: "rispondo" });
    expect(approvalStatusOf(id)).toBe("rejected");
    const after = (await (await call(router, "GET", `/api/boards/${BOARD}/tasks/${id}`))!.json()).comments;
    expect(after.length).toBeGreaterThan(before);
  });

  // A STEP (a card with `parentTaskId`) never requeues on its own: the tick
  // and `onEnterTodo` both read only root cards, so a step put in `todo`
  // would wait forever for nobody. The only thing a step's comment can do is
  // wake its dispatch ROOT.
  async function stepUnder(parentId: string, machineId?: string): Promise<string> {
    const t = await (await call(router, "POST", `/api/boards/${BOARD}/tasks`, { text: "step", status: "in_progress", parentTaskId: parentId, machineId }))!.json();
    return t.id;
  }

  test("a comment on a step wakes the PARENT dispatch root, not the step itself", async () => {
    const parentId = await cardInReview(localId);
    const stepId = await stepUnder(parentId);
    // Adding the step itself already resumes the parent ("a new step landed
    // on your task") — reset the tracking arrays so the assertions below are
    // about the COMMENT, not the step's own creation.
    resumed.length = 0; entered.length = 0;
    const resp = (await call(router, "POST", `/api/boards/${BOARD}/tasks/${stepId}/comments`, { content: "sul tuo sottotask" }))!;
    expect((await resp.json()).delivery).toBe("queued");
    expect(statusOf(parentId)).toBe("in_progress");
    expect(resumed).toEqual([parentId]);
    expect(entered).toEqual([]);
    // The step itself never moved — nothing would ever pick it up from `todo`.
    expect(statusOf(stepId)).toBe("in_progress");
  });

  test("a comment on a step whose root has no topic to wake answers 'note', never 'queued'", async () => {
    // The root (top-level) card has no assigned topic at all — a node
    // delivered it, or its session was released — so `boundRootOf` finds no
    // ancestor with a live topic for this step either.
    const parent = await (await call(router, "POST", `/api/boards/${BOARD}/tasks`, { text: "deliver", status: "in_progress", machineId: nodeId }))!.json();
    const stepId = await stepUnder(parent.id, nodeId);
    await call(router, "PATCH", `/api/boards/${BOARD}/tasks/${stepId}`, { status: "review" });
    const resp = (await call(router, "POST", `/api/boards/${BOARD}/tasks/${stepId}/comments`, { content: "sul tuo sottotask" }))!;
    expect((await resp.json()).delivery).toBe("note");
    expect(resumed).toEqual([]);
    expect(entered).toEqual([]);
    // Honest: the step stays exactly where it was, never silently requeued.
    expect(statusOf(stepId)).toBe("review");
  });
});
