/**
 * THE PREVIEW GATE on the move to review.
 *
 * A card the board has ALREADY labelled `visibile` touches `client/src/**`, so
 * the reviewer opens it to LOOK at something: it delivers with a durable
 * preview or it does not deliver. Every other class is untouched, and that
 * narrowness is the point — asking a card with no surface for a screenshot
 * manufactures an artefact for the gate instead of for the person reading it.
 *
 * Its own file, next to `tasks.hooks-gate.test.ts` and `tasks.checks-gate.test.ts`.
 * The ORDER is pinned too, and stated as it really is: this gate sits AFTER the
 * dirt probe and BEFORE the board's commands. It costs a field read where those
 * cost minutes, so a delivery that cannot pass learns it before a check run is
 * paid for - but the worktree has already been looked at, and the case below
 * asserts exactly that rather than claiming the gate comes first.
 * @covers BOARD-POLICY-01
 */
import { test, expect, describe, beforeEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTasksRouter } from "./tasks";
import { freshDb, makeCtx, call } from "./tasks-test-support";

describe("the preview gate", () => {
  let db: Database; let broadcasts: any[];
  let probed: string[];

  beforeEach(() => { db = freshDb(); broadcasts = []; probed = []; });

  const mk = () => createTasksRouter(makeCtx(db, broadcasts), undefined, {
    taskCheckoutRef: async () => ({ cwd: "/wt/of/the/card", commit: "abc1234" }),
    taskWorktreeDirtProbe: async (taskId: string) => { probed.push(taskId); return { ok: true, paths: [] }; },
  } as any);

  /** An agent delivery ready for the gates: task plus its summary comment. */
  async function delivered(router: any) {
    const t = await (await call(router, "POST", "/api/sessions/s1/tasks", { text: "x" }))!.json();
    await call(router, "POST", `/api/sessions/s1/tasks/${t.id}/comments`, { content: "done, see demo/" });
    return t;
  }

  /** The label as the board writes it at delivery: `source: 'derived'`. */
  function label(taskId: string, value: string) {
    db.run("INSERT INTO task_labels (task_id, label, source, created_at) VALUES (?, ?, 'derived', ?)",
      [taskId, value, new Date().toISOString()]);
  }

  const deliver = (r: any, id: string) =>
    call(r, "PATCH", `/api/sessions/s1/tasks/${id}`, { status: "review", summary: "delivery summary" });

  test("NEGATIVE: a `visibile` card with no preview is refused, with its own code, and does not move", async () => {
    const r = mk();
    const t = await delivered(r);
    label(t.id, "visibile");

    const resp = (await deliver(r, t.id))!;
    expect(resp.status).toBe(409);
    const err = await resp.json();
    expect(err.code).toBe("review_needs_preview");
    // The message has to say what to DO, not just what is wrong.
    expect(err.error).toContain("previewImage");

    const got = await (await call(r, "GET", `/api/sessions/s1/tasks/${t.id}`))!.json();
    expect(got.task.status).not.toBe("review");
    // ORDER, asserted and not just claimed: the dirt probe ran (this gate is
    // after it), and the refusal happened before the board's commands would
    // have been paid for.
    expect(probed).toEqual([t.id]);
  });

  test("POSITIVE: the same card delivers once the preview is attached", async () => {
    const r = mk();
    const t = await delivered(r);
    label(t.id, "visibile");
    // Refused before.
    expect((await deliver(r, t.id))!.status).toBe(409);

    await call(r, "PATCH", `/api/sessions/s1/tasks/${t.id}`, { previewImage: "/tmp/shot.png" });
    const resp = (await deliver(r, t.id))!;
    expect(resp.status).toBe(200);
    const got = await (await call(r, "GET", `/api/sessions/s1/tasks/${t.id}`))!.json();
    expect(got.task.status).toBe("review");
  });

  test("a whitespace-only preview is not a preview", async () => {
    const r = mk();
    const t = await delivered(r);
    label(t.id, "visibile");
    await call(r, "PATCH", `/api/sessions/s1/tasks/${t.id}`, { previewImage: "   " });
    expect((await deliver(r, t.id))!.status).toBe(409);
  });

  test("the OTHER classes pass untouched: `decisione` and `invisibile` never need one", async () => {
    for (const cls of ["decisione", "invisibile"]) {
      db = freshDb(); broadcasts = []; probed = [];
      const r = mk();
      const t = await delivered(r);
      label(t.id, cls);
      const resp = (await deliver(r, t.id))!;
      expect(resp.status).toBe(200);
      const got = await (await call(r, "GET", `/api/sessions/s1/tasks/${t.id}`))!.json();
      expect(got.task.status).toBe("review");
    }
  });

  test("a card with NO label yet is not held back: the gate answers about what is written", async () => {
    const r = mk();
    const t = await delivered(r);
    // No label row at all — the derivation has not run. The gate must not guess.
    const resp = (await deliver(r, t.id))!;
    expect(resp.status).toBe(200);
  });

  test("a genre label alone does not trigger it: only the closer class `visibile` does", async () => {
    const r = mk();
    const t = await delivered(r);
    label(t.id, "feature");
    expect((await deliver(r, t.id))!.status).toBe(200);
  });
});
