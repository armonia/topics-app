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
import { FRESH_SESSION_NOTE } from "../../shared/task-comment-service";

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

  async function cardInReview(machineId: string, opts: { withTopic?: boolean } = {}): Promise<string> {
    const t = await (await call(router, "POST", `/api/boards/${BOARD}/tasks`, { text: "deliver", status: "in_progress", machineId }))!.json();
    if (opts.withTopic !== false) db.prepare("UPDATE tasks SET assigned_topic_id = 'top-x' WHERE id = ?").run(t.id);
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

  // The REAL shape of the incident (KANBAN-76, measured twice on 12/11): a
  // card a node delivered never has a local topic to begin with — the
  // fixture above gives every card `assigned_topic_id = 'top-x'`, which is
  // why that test still passed on the broken code. This one has none.
  test("a card delivered by a node with NO topic at all also goes back to todo", async () => {
    const id = await cardInReview(nodeId, { withTopic: false });
    const resp = (await call(router, "POST", `/api/boards/${BOARD}/tasks/${id}/comments`, { content: "rispondo" }))!;
    expect((await resp.json()).delivery).toBe("queued");
    expect(statusOf(id)).toBe("todo");
    expect(entered).toEqual([[BOARD, id]]);
    expect(resumed).toEqual([]);
  });

  // A local card whose session was released (no topic) has the same shape as
  // a node card to this route, and must requeue the same way.
  test("a local card in review with no topic (session released) also goes back to todo", async () => {
    const id = await cardInReview(localId, { withTopic: false });
    const resp = (await call(router, "POST", `/api/boards/${BOARD}/tasks/${id}/comments`, { content: "rispondo" }))!;
    expect((await resp.json()).delivery).toBe("queued");
    expect(statusOf(id)).toBe("todo");
    expect(entered).toEqual([[BOARD, id]]);
    expect(resumed).toEqual([]);
  });

  // A STALE local row (an old hostname this same Mac had before, `base_url`
  // NULL, a different id than today's `upsertLocal()`) is NOT a node:
  // `isRemoteTask` (task-dispatcher.ts) reads a missing address as local, and
  // this route must agree — treating it as a node sent the card to `todo`
  // with FRESH_SESSION_NOTE while `launchOnNode` later bounced it back with
  // "no known address", after the route had already answered `queued`.
  test("a card whose machine row is a stale LOCAL row (no base_url) keeps reject+resume, not a node requeue", async () => {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO machines (id, name, hostname, arch, platform, daemon_version, status, last_heartbeat_at, last_seen_at, created_at, updated_at)
       VALUES ('stale-local', 'Old Mac', 'old-hostname', 'arm64', 'darwin', '0.0.0', 'offline', ?, ?, ?, ?)`,
    ).run(now, now, now, now);
    const id = await cardInReview("stale-local");
    const resp = (await call(router, "POST", `/api/boards/${BOARD}/tasks/${id}/comments`, { content: "continua" }))!;
    expect((await resp.json()).delivery).toBe("queued");
    expect(statusOf(id)).toBe("in_progress");
    expect(resumed).toEqual([id]);
    expect(entered).toEqual([]);
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
    await call(router, "POST", `/api/boards/${BOARD}/tasks/${id}/comments`, { content: "rispondo" });
    expect(approvalStatusOf(id)).toBe("rejected");
    const after = (await (await call(router, "GET", `/api/boards/${BOARD}/tasks/${id}`))!.json()).comments;
    expect(after.at(-1).content).toBe(FRESH_SESSION_NOTE);
  });

  // THE DIRECT COMPARISON: same shape, two doors — the sveglia comment and
  // the explicit `board_review reject` — must land in the same place
  // (status, approval outcome, last note), because `requeueUnboundReject`
  // is the one function both call, not two copies that could drift apart.
  test("a comment's reject on a node card matches an explicit board_review reject on a twin card", async () => {
    // withTopic: false — the real shape (point 1 above): a node-delivered
    // card never has a local topic, so both doors hit the same "nobody to
    // resume locally" branch instead of silently diverging on a fixture
    // detail neither production code path can see in practice.
    const viaComment = await cardInReview(nodeId, { withTopic: false });
    const viaReject = await cardInReview(nodeId, { withTopic: false });

    await call(router, "POST", `/api/boards/${BOARD}/tasks/${viaComment}/comments`, { content: "rispondo" });
    await call(router, "POST", `/api/boards/${BOARD}/tasks/${viaReject}/review`, { decision: "reject" });

    expect(statusOf(viaComment)).toBe(statusOf(viaReject));
    expect(statusOf(viaComment)).toBe("todo");
    expect(approvalStatusOf(viaComment)).toBe(approvalStatusOf(viaReject));
    expect(approvalStatusOf(viaComment)).toBe("rejected");
    const notesOf = async (id: string) =>
      (await (await call(router, "GET", `/api/boards/${BOARD}/tasks/${id}`))!.json()).comments.at(-1).content;
    expect(await notesOf(viaComment)).toBe(await notesOf(viaReject));
    expect(await notesOf(viaComment)).toBe(FRESH_SESSION_NOTE);
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

  // The step's OWN machine never decides anything: only the ancestor
  // `boundRootOf` finds has a say, so a node step under a locally-bound
  // root still wakes that root — the step's `machineId` is irrelevant here.
  test("a comment on a NODE step whose root has a topic wakes the parent, same as a local step", async () => {
    const parentId = await cardInReview(localId);
    const stepId = await stepUnder(parentId, nodeId);
    resumed.length = 0; entered.length = 0;
    const resp = (await call(router, "POST", `/api/boards/${BOARD}/tasks/${stepId}/comments`, { content: "sul tuo sottotask" }))!;
    expect((await resp.json()).delivery).toBe("queued");
    expect(statusOf(parentId)).toBe("in_progress");
    expect(resumed).toEqual([parentId]);
    expect(entered).toEqual([]);
  });

  // Mirror of the node-step case above: a LOCAL step under a node root with
  // no topic gets the same honest 'note' — the step's own `machineId` (none,
  // here) still cannot save it if the root it climbs to has nothing to wake.
  test("a comment on a LOCAL step whose root is a node with no topic answers 'note'", async () => {
    const parent = await (await call(router, "POST", `/api/boards/${BOARD}/tasks`, { text: "deliver", status: "in_progress", machineId: nodeId }))!.json();
    const stepId = await stepUnder(parent.id);
    await call(router, "PATCH", `/api/boards/${BOARD}/tasks/${stepId}`, { status: "review" });
    const resp = (await call(router, "POST", `/api/boards/${BOARD}/tasks/${stepId}/comments`, { content: "sul tuo sottotask" }))!;
    expect((await resp.json()).delivery).toBe("note");
    expect(resumed).toEqual([]);
    expect(entered).toEqual([]);
    expect(statusOf(stepId)).toBe("review");
  });
});
