/**
 * @covers LAND-15
 * A RED CARD IN REVIEW GOES BACK TO ITS AGENT BY ITSELF (`services/red-bounce.ts`).
 *
 * End to end through the router: a card reaches review, its bar turns red
 * afterwards (what a node delivery does), and the sweep sends it back with the
 * failing output, without anybody pressing reject. After three such rounds with
 * no word from a person, it stays and asks.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTasksRouter } from "./tasks";
import { createTaskService, type TaskService } from "../services/tasks";
import { freshDb, makeCtx, call } from "./tasks-test-support";
import { RED_BOUNCE_NOTE } from "../services/red-bounce";

describe("a red card in review goes back to its agent", () => {
  let db: Database; let svc: TaskService; let sweep: (() => Promise<number>) | null = null;
  const cwd = mkdtempSync(join(tmpdir(), "tasks-red-bounce-"));

  beforeEach(() => { db = freshDb(); svc = createTaskService(db); sweep = null; });
  afterAll(() => { rmSync(cwd, { recursive: true, force: true }); });

  async function inReview() {
    const router = createTasksRouter(makeCtx(db, []), undefined, {
      taskCheckoutRef: async () => ({ cwd, commit: "abc1234" }),
      realignForChecks: async () => ({ ok: true, note: null }),
      taskDeliveryRef: async () => ({ branch: "topics/red", commit: "abc1234", repoPath: "/repo" }),
      ownCommitFiles: async () => [{ path: "server/lib/x.ts", added: true }],
      deliveryFiles: async () => ["server/lib/x.ts"],
      deliveryReferenced: async () => [],
      onAutoLand: (api: { sweepAutoLand: () => Promise<number> }) => { sweep = api.sweepAutoLand; },
    } as Parameters<typeof createTasksRouter>[2]);
    const task = await (await call(router, "POST", "/api/sessions/s1/tasks", { text: "sistema i test" }))!.json();
    db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(task.id);
    await call(router, "POST", `/api/sessions/s1/tasks/${task.id}/comments`, { content: "fatto" });
    svc.updateBoardSettings(task.projectId, { dispatchAutoMerge: false, reviewChecks: [{ name: "ok", cmd: "true" }] });
    await call(router, "PATCH", `/api/sessions/s1/tasks/${task.id}`, { status: "review", summary: "sistemati", legMs: 10_000 });
    expect(svc.get(task.id)!.task.status).toBe("review");
    return task.id as string;
  }

  /** The bar turns red AFTER the card entered review, on the delivered commit. */
  function turnRed(id: string, commit = "abc1234") {
    const runs = [{ name: "gates:fast", cmd: "bun run gates:fast", ok: false, code: 1, ms: 900, timedOut: false, tail: "check:bloat FAIL" }];
    db.prepare("UPDATE tasks SET checks_state = 'fail', checks_commit = ?, checks_json = ?, delivery_commit = 'abc1234', delivery_branch = 'topics/red', status = 'review' WHERE id = ?")
      .run(commit, JSON.stringify(runs), id);
  }

  test("the sweep sends a red review card back with the failing command, no person involved", async () => {
    const id = await inReview();
    turnRed(id);
    await sweep!();
    const after = svc.get(id)!;
    expect(after.task.status).toBe("in_progress");
    const note = after.comments.find((c) => c.content.startsWith(RED_BOUNCE_NOTE));
    expect(note?.author).toBe("system");
    expect(note?.content).toContain("gates:fast");
  }, 30_000);

  test("a red measured on a previous tip does not move the card", async () => {
    const id = await inReview();
    turnRed(id, "fffffff9");
    await sweep!();
    expect(svc.get(id)!.task.status).toBe("review");
  }, 30_000);

  test("after three red rounds the card stays in review and asks the person", async () => {
    const id = await inReview();
    for (let round = 0; round < 3; round++) {
      turnRed(id);
      await sweep!();
      expect(svc.get(id)!.task.status).toBe("in_progress");
    }
    turnRed(id);
    await sweep!();
    const after = svc.get(id)!.task;
    expect(after.status).toBe("review");
    expect(after.humanAsk).toContain("Tre giri rossi");
  }, 30_000);
});
