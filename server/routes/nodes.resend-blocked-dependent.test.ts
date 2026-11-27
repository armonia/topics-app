/**
 * @covers KANBAN-124
 *
 * A RESEND MUST NOT FAIL BECAUSE THE PRIOR RUN STILL BLOCKS A LIVE DEPENDENT.
 *
 * Review feedback 26/11, point 4: the kickoff tells every agent to self-link
 * its next step with `blockedByTaskId` (KANBAN-124), so the prior run card —
 * idle, in `review`, about to be replaced by a fresh run for the same
 * `originTaskId` — almost always still "blocks a live dependent" and
 * `deleteBoardTask` answers 409 `blocks_live_dependent`. Before the fix this
 * aborted the whole resend: `POST /api/nodes/runs` returned that same 409 and
 * no new run ever started. The prior card not archiving is fine on its own
 * (it is already idle, nothing is running under it, and its dependent
 * correctly keeps waiting) — only a DIFFERENT failure should still abort.
 */
import { describe, expect, test } from "bun:test";
import { projectIdForPath } from "../../shared/board-base";
import { createNodesRouter } from "./nodes";
import { createTasksRouter } from "./tasks";
import { call, freshDb, makeCtx } from "./tasks-test-support";

const REPO_PATH = "/repo";
const BOARD_ID = projectIdForPath(REPO_PATH);
const ORIGIN_KEY = "https://github.com/example/repo.git";
const ORIGIN_TASK_ID = "origin-card";
const RUN_KEY = `node-run:${ORIGIN_TASK_ID}`;

function setup(deleteBoardTask: (projectId: string, taskId: string) => Promise<Response>) {
  const db = freshDb();
  const ctx = { ...makeCtx(db, []), projectStore: { list: () => [{ id: BOARD_ID, path: REPO_PATH }], get: () => null } } as any;
  const tasksRouter = createTasksRouter(ctx, undefined);
  const nodesRouter = createNodesRouter(ctx, {
    deleteBoardTask,
    runGit: async () => ({ code: 0, stdout: ORIGIN_KEY, stderr: "" }),
  });
  return { db, tasksRouter, nodesRouter };
}

async function resend(nodesRouter: ReturnType<typeof createNodesRouter>) {
  const url = new URL("http://topics.test/api/nodes/runs");
  return nodesRouter(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ originTaskId: ORIGIN_TASK_ID, originUrl: ORIGIN_KEY, text: "Mirror" }),
    }),
    url, url.pathname, "POST",
  );
}

describe("resending a node run whose prior card still blocks a live dependent", () => {
  test("starts the new run anyway, leaving the prior card unarchived", async () => {
    const { db, tasksRouter, nodesRouter } = setup(async () =>
      new Response(JSON.stringify({ error: "x", code: "blocks_live_dependent" }), { status: 409 }));

    const prior = await (await call(tasksRouter, "POST", `/api/boards/${BOARD_ID}/tasks`, { text: "prior run" }))!.json();
    db.prepare("UPDATE tasks SET claude_task_id = ?, status = 'review', dispatch_state = 'queued' WHERE id = ?")
      .run(RUN_KEY, prior.id);
    await call(tasksRouter, "POST", `/api/boards/${BOARD_ID}/tasks`, { text: "dipendente", blockedByTaskId: prior.id });

    const resp = await resend(nodesRouter);
    expect(resp?.status).toBe(201);
    const body = await resp!.json();
    expect(body.runId).not.toBe(prior.id);

    const priorRow = db.prepare("SELECT archived, claude_task_id FROM tasks WHERE id = ?").get(prior.id) as any;
    expect(priorRow.archived, "still unarchived: its dependent keeps waiting").toBe(0);
    expect(priorRow.claude_task_id, "the key moved to the new run").toBeNull();
  });

  test("a different delete failure still aborts the resend", async () => {
    const { db, tasksRouter, nodesRouter } = setup(async () => new Response(null, { status: 500 }));

    const prior = await (await call(tasksRouter, "POST", `/api/boards/${BOARD_ID}/tasks`, { text: "prior run" }))!.json();
    db.prepare("UPDATE tasks SET claude_task_id = ?, status = 'review', dispatch_state = 'queued' WHERE id = ?")
      .run(RUN_KEY, prior.id);

    const resp = await resend(nodesRouter);
    expect(resp?.status).toBe(500);
    const priorRow = db.prepare("SELECT claude_task_id FROM tasks WHERE id = ?").get(prior.id) as any;
    expect(priorRow.claude_task_id, "a genuine failure never frees the key").toBe(RUN_KEY);
  });
});
