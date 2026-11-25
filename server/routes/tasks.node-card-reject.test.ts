/**
 * An explicit reject (`board_review reject`, the Rimanda button) of a card in
 * review that a NODE delivered. The comments route already sent such a card back
 * to todo; the review route resumed the topic still bound to it, which starts an
 * agent on THIS Mac, where the work is not: card f3c5a186 answered «il lavoro è
 * sul nodo, non qui» and nothing reached the node that holds the branch.
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

const BOARD = "node-board-reject123";

describe("reject of a card in review", () => {
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
    // A real delivery leaves a pending review approval; the fixture opens it by hand.
    db.prepare(
      `INSERT INTO approvals (id, task_id, requested_by, approval_type, from_status, to_status, status, created_at)
       VALUES (?, ?, 'agent', 'review', 'in_progress', 'done', 'pending', 'now')`,
    ).run(`appr-${t.id}`, t.id);
    return t.id;
  }
  const statusOf = (id: string) => (db.query("SELECT status FROM tasks WHERE id = ?").get(id) as { status: string }).status;
  const reject = async (id: string) =>
    (await call(router, "POST", `/api/boards/${BOARD}/tasks/${id}/review`, { decision: "reject", comment: "unisci origin/main nel ramo e riconsegna" }, {}))!;

  test("a node card that still has a bound topic goes back to todo, and nothing is resumed on this Mac", async () => {
    const id = await cardInReview(nodeId);
    const res = await reject(id);
    expect(res.status).toBe(200);
    expect(statusOf(id)).toBe("todo");
    expect(entered).toEqual([[BOARD, id]]);
    expect(resumed).toEqual([]);
  });

  test("a card on this Mac with a bound topic keeps reject+resume", async () => {
    const id = await cardInReview(localId);
    const res = await reject(id);
    expect(res.status).toBe(200);
    expect(statusOf(id)).toBe("in_progress");
    expect(resumed).toEqual([id]);
    expect(entered).toEqual([]);
  });
});
