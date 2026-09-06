/**
 * THE USER'S `task-deliver` HOOK, the first gate on the move to review.  @covers HOOKS-02
 *
 * Twin of the two service refusals (`review_needs_commit`, the checks): a
 * non-zero exit answers 409 with a code of its own and the command's stderr
 * as the reason. Its own file, like `tasks.checks-gate.test.ts`, and with one
 * assertion the others do not need: the ORDER. The hook is the cheapest gate
 * of the chain and must be able to refuse before a git status is run and a
 * full check run is paid for, so the dirt probe is a spy that must stay cold
 * on a refusal and warm on a pass.
 */
import { test, expect, describe, beforeEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTasksRouter } from "./tasks";
import { freshDb, makeCtx, call } from "./tasks-test-support";
import type { LifecycleHookRunner, LifecycleHookPayload } from "../services/lifecycle-hooks";

describe("the task-deliver hook gate", () => {
  let db: Database; let broadcasts: any[];
  let probed: string[];
  let seen: Array<[string, LifecycleHookPayload]>;

  beforeEach(() => { db = freshDb(); broadcasts = []; probed = []; seen = []; });

  const mk = (verdict: { ok: true } | { ok: false; reason: string }) => {
    const hooks: LifecycleHookRunner = {
      run: async (event, payload) => { seen.push([event, payload]); return verdict; },
    };
    return createTasksRouter(makeCtx(db, broadcasts), undefined, {
      hooks,
      taskCheckoutRef: async () => ({ cwd: "/wt/of/the/card", commit: "abc1234" }),
      taskWorktreeDirtProbe: async (taskId: string) => { probed.push(taskId); return { ok: true, paths: [] }; },
    } as any);
  };

  /** An agent delivery ready for the gates: task plus its summary comment. */
  async function delivered(router: any) {
    const t = await (await call(router, "POST", "/api/sessions/s1/tasks", { text: "x" }))!.json();
    await call(router, "POST", `/api/sessions/s1/tasks/${t.id}/comments`, { content: "done, see demo/" });
    return t;
  }

  test("a refusing hook: 409 with its own code and the stderr as reason; the dirt probe was never asked", async () => {
    const r = mk({ ok: false, reason: "the changelog is empty" });
    const t = await delivered(r);
    const resp = (await call(r, "PATCH", `/api/sessions/s1/tasks/${t.id}`, { status: "review", summary: "delivery summary" }))!;
    expect(resp.status).toBe(409);
    const err = await resp.json();
    expect(err.code).toBe("review_hook_refused");
    expect(err.error).toBe("the changelog is empty");
    // ORDER: the refusal came before the chain paid for a git status.
    expect(probed).toEqual([]);
    // And the card did not move.
    const got = await (await call(r, "GET", `/api/sessions/s1/tasks/${t.id}`))!.json();
    expect(got.task.status).not.toBe("review");
    // What the hook read: the event, the session, the worktree as cwd, the card.
    expect(seen).toHaveLength(1);
    expect(seen[0]![0]).toBe("task-deliver");
    expect(seen[0]![1]).toMatchObject({
      hook_event_name: "task-deliver", session_id: "s1", cwd: "/wt/of/the/card", task_id: t.id, commit: "abc1234",
    });
  });

  test("an allowing hook is silent: the delivery goes on to the dirt probe and lands in review", async () => {
    const r = mk({ ok: true });
    const t = await delivered(r);
    const resp = (await call(r, "PATCH", `/api/sessions/s1/tasks/${t.id}`, { status: "review", summary: "delivery summary" }))!;
    expect(resp.status).toBe(200);
    expect(probed).toEqual([t.id]);
    const got = await (await call(r, "GET", `/api/sessions/s1/tasks/${t.id}`))!.json();
    expect(got.task.status).toBe("review");
  });

  test("a move that is not a delivery never asks the hook", async () => {
    const r = mk({ ok: false, reason: "would refuse" });
    const t = await delivered(r);
    const resp = (await call(r, "PATCH", `/api/sessions/s1/tasks/${t.id}`, { status: "in_progress" }))!;
    expect(resp.status).toBe(200);
    expect(seen).toEqual([]);
  });
});
