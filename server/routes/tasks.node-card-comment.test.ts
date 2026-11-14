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

  async function cardInReview(machineId: string, opts?: { withLocalTopic?: boolean }): Promise<string> {
    const t = await (await call(router, "POST", `/api/boards/${BOARD}/tasks`, { text: "deliver", status: "in_progress", machineId }))!.json();
    // A LOCALLY dispatched card is bound to a topic (the live session); a card
    // a NODE delivered never gets one here, because the session it ran lives
    // on the node, not on this Mac — `assigned_topic_id` stays NULL for the
    // whole chain. Setting it unconditionally used to hide exactly that gap:
    // see the «without a local topic» test below, which is the real shape of
    // 28b5facb/30f7c880.
    if (opts?.withLocalTopic !== false) db.prepare("UPDATE tasks SET assigned_topic_id = 'top-x' WHERE id = ?").run(t.id);
    await call(router, "PATCH", `/api/boards/${BOARD}/tasks/${t.id}`, { status: "review" });
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

  // THE CARD AS IT REALLY ARRIVES: no local topic was ever bound, because the
  // run lived entirely on the node (28b5facb, 30f7c880, measured 12/11).
  // `boundRootOf` finds no ancestor with a topic and comes back null — the
  // route must still recognise the task itself as a node card in review
  // instead of silently doing nothing while answering "queued".
  test("a card delivered by a node with no local topic bound still goes back to todo", async () => {
    const id = await cardInReview(nodeId, { withLocalTopic: false });
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

  // A SUBTASK OF A LOCALLY-BOUND PARENT, delivered by a node itself (the
  // overflow dispatch does not exclude subtasks). `boundRootOf` climbs past
  // the child — which has no topic — straight to the parent, which DOES, so
  // the node branch must look at the commented card, not only at `root`.
  test("a node's subtask whose parent has a local topic still goes back to todo", async () => {
    const parent = await (await call(router, "POST", `/api/boards/${BOARD}/tasks`, { text: "parent", status: "in_progress", machineId: localId }))!.json();
    db.prepare("UPDATE tasks SET assigned_topic_id = 'top-x' WHERE id = ?").run(parent.id);
    const child = await (await call(router, "POST", `/api/boards/${BOARD}/tasks`, { text: "child", status: "in_progress", machineId: nodeId, parentTaskId: parent.id }))!.json();
    await call(router, "PATCH", `/api/boards/${BOARD}/tasks/${child.id}`, { status: "review" });
    const resp = (await call(router, "POST", `/api/boards/${BOARD}/tasks/${child.id}/comments`, { content: "rispondo" }))!;
    expect(resp.status).toBe(201);
    expect((await resp.json()).delivery).toBe("queued");
    expect(statusOf(child.id)).toBe("todo");
    expect(entered).toEqual([[BOARD, child.id]]);
    expect(resumed).toEqual([]);
  });

  // A LOCAL card in review whose session was already released (a restart
  // with dispatch off, a requeue): no topic to resume, same as the unbound
  // path `board_review reject` already handles.
  test("a local card in review with a released session goes back to todo, same as an unbound reject", async () => {
    const id = await cardInReview(localId, { withLocalTopic: false });
    const resp = (await call(router, "POST", `/api/boards/${BOARD}/tasks/${id}/comments`, { content: "continua" }))!;
    expect(resp.status).toBe(201);
    expect((await resp.json()).delivery).toBe("queued");
    expect(statusOf(id)).toBe("todo");
    expect(entered).toEqual([[BOARD, id]]);
    expect(resumed).toEqual([]);
  });

  // A node card whose machine row has since lost its `base_url` (unpaired,
  // offline): still not a card this Mac can resume, so it must still queue —
  // never fall through to a silent `note`.
  test("a node card with no base_url on its machine row still goes back to todo", async () => {
    db.run("UPDATE machines SET base_url = NULL WHERE id = ?", [nodeId]);
    const id = await cardInReview(nodeId);
    const resp = (await call(router, "POST", `/api/boards/${BOARD}/tasks/${id}/comments`, { content: "rispondo" }))!;
    expect(resp.status).toBe(201);
    expect((await resp.json()).delivery).toBe("queued");
    expect(statusOf(id)).toBe("todo");
    expect(entered).toEqual([[BOARD, id]]);
    expect(resumed).toEqual([]);
  });
});
