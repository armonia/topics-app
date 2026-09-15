/**
 * A DELIVERY WHOSE CHECKS THE SHUTDOWN CUT DOES NOT ENTER REVIEW.  @covers KANBAN-15
 *
 * `stopReviewChecks` (called by `gracefulShutdown`) kills the running check
 * trees, and the round throws instead of recording the killed run. The gate
 * used to turn that throw into `null`, the word for "this board declares no
 * checks", and the delivery gate let the PATCH go on: probed on the branch with
 * a `sleep 120` check and a 20 s leg in flight, the answer was 200 and the card
 * sat in review with `checksState: running`, on every watcher reload.
 *
 * Its own file: `tasks.test.ts` is far past the size gate, and this is a
 * question about the route and the shutdown together, which neither the
 * service test of the round nor the gate's own test can see.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTasksRouter } from "./tasks";
import { freshDb, makeCtx, call } from "./tasks-test-support";
import { freezableRuns } from "../services/budget-governor";
import { _resetReviewChecksStop, stopReviewChecks } from "../services/review-checks-brakes";

describe("a server shutdown during the pre-review checks of a delivery", () => {
  let db: Database; let broadcasts: unknown[]; let cwd = "";

  beforeAll(() => { cwd = mkdtempSync(join(tmpdir(), "tasks-checks-interrupted-")); });
  afterAll(() => { rmSync(cwd, { recursive: true, force: true }); });
  beforeEach(() => { db = freshDb(); broadcasts = []; });
  // A stop is for the life of the process; every other file must see a server that runs.
  afterEach(() => { _resetReviewChecksStop(); });

  /** A card in progress with its summary said, checks declared, and a counter on the realign. */
  async function deliveryWith(cmd: string, over: Record<string, unknown> = {}) {
    const realigns = { count: 0 };
    const router = createTasksRouter(makeCtx(db, broadcasts), undefined, {
      taskCheckoutRef: async () => ({ cwd, commit: "abc1234" }),
      realignForChecks: async () => { realigns.count += 1; return { ok: true, note: null }; },
      ...over,
    } as Parameters<typeof createTasksRouter>[2]);
    const task = await (await call(router, "POST", "/api/sessions/s1/tasks", { text: "consegna" }))!.json();
    db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(task.id);
    await call(router, "POST", `/api/sessions/s1/tasks/${task.id}/comments`, { content: "fatto, guarda demo/" });
    await call(router, "PATCH", `/api/boards/${task.projectId}/settings`, { reviewChecks: [{ name: "bar", cmd }] });
    const deliver = () => call(router, "PATCH", `/api/sessions/s1/tasks/${task.id}`, {
      status: "review", summary: "riassunto della consegna", legMs: 20_000,
    });
    const read = async () => (await (await call(router, "GET", `/api/sessions/s1/tasks/${task.id}`))!.json()).task;
    return { id: task.id as string, deliver, read, realigns };
  }

  async function until(cond: () => boolean | Promise<boolean>, what: string): Promise<void> {
    for (let i = 0; i < 400; i++) {
      if (await cond()) return;
      await Bun.sleep(25);
    }
    throw new Error(`never happened: ${what}`);
  }

  async function expectRetryAnswer(resp: Response): Promise<void> {
    expect(resp.status).toBe(503);
    expect(resp.headers.get("Retry-After")).toBe("60");
    const body = await resp.json();
    expect(body.code).toBe("review_checks_interrupted");
    expect(body.error).toContain("again");
  }

  test("a command killed with the leg in flight: 503 call again, and the card stays in progress", async () => {
    const d = await deliveryWith("sleep 120");
    const leg = d.deliver();
    await until(() => freezableRuns().some((r) => r.taskId === d.id), "the check tree is running");

    expect(await stopReviewChecks()).toBe(1);
    await expectRetryAnswer((await leg)!);
    const after = await d.read();
    expect(after.status).toBe("in_progress");
    expect(after.checksState).not.toBe("pass");
    expect(after.checksState).not.toBe("fail");
    expect(d.realigns.count).toBe(1);

    // The legs that arrive while the server is still going away start no round:
    // no realign runs a merge the exit could cut in half.
    await expectRetryAnswer((await d.deliver())!);
    expect(d.realigns.count).toBe(1);
    expect((await d.read()).status).toBe("in_progress");
  }, 60_000);

  test("a round stopped while it waits for memory answers the same, and its command never starts", async () => {
    const marker = join(cwd, "started-after-stop");
    const d = await deliveryWith(`touch ${marker}`, {
      checksMemoryFloor: { read: () => 1, floorGB: 6, pollMs: 25 },
    });
    const leg = d.deliver();
    await until(async () => (await d.read()).checksState === "running", "the round is waiting");

    await stopReviewChecks();
    await expectRetryAnswer((await leg)!);
    expect((await d.read()).status).toBe("in_progress");
    expect(await Bun.file(marker).exists()).toBe(false);
  }, 60_000);
});
