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
 * The answer is the one of a leg still in flight, never an error: the route's
 * only client (`callUpdateTask`) keeps polling, meets the closed socket of the
 * exit and retries that silence within its transport grace. A 503 here was
 * thrown at the agent, which called again into the dead server.
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
import { callUpdateTask } from "../mcp/topics-mcp-server";

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
    const checkouts = { count: 0 };
    // A server process: its own checks gate over the same database, so a second
    // one stands for the server the watcher brings back up.
    const boot = () => createTasksRouter(makeCtx(db, broadcasts), undefined, {
      taskCheckoutRef: async () => { checkouts.count += 1; return { cwd, commit: "abc1234" }; },
      realignForChecks: async () => { realigns.count += 1; return { ok: true, note: null }; },
      ...over,
    } as Parameters<typeof createTasksRouter>[2]);
    const router = boot();
    const task = await (await call(router, "POST", "/api/sessions/s1/tasks", { text: "consegna" }))!.json();
    db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(task.id);
    await call(router, "POST", `/api/sessions/s1/tasks/${task.id}/comments`, { content: "fatto, guarda demo/" });
    await call(router, "PATCH", `/api/boards/${task.projectId}/settings`, { reviewChecks: [{ name: "bar", cmd }] });
    const deliver = (legMs = 20_000) => call(router, "PATCH", `/api/sessions/s1/tasks/${task.id}`, {
      status: "review", summary: "riassunto della consegna", legMs,
    });
    const read = async () => (await (await call(router, "GET", `/api/sessions/s1/tasks/${task.id}`))!.json()).task;
    return { id: task.id as string, router, boot, deliver, read, realigns, checkouts };
  }

  async function until(cond: () => boolean | Promise<boolean>, what: string): Promise<void> {
    for (let i = 0; i < 400; i++) {
      if (await cond()) return;
      await Bun.sleep(25);
    }
    throw new Error(`never happened: ${what}`);
  }

  /** The answer of a leg whose round is still running, and nothing that reads as an error. */
  async function expectLegInFlight(resp: Response): Promise<void> {
    expect(resp.status).toBe(202);
    const body = await resp.json();
    expect(body.pending).toBe(true);
    expect(body.code).toBe("review_checks_running");
    expect(body.error).toBeUndefined();
  }

  test("a command killed with the leg in flight: the leg answers still running, and the card stays in progress", async () => {
    const d = await deliveryWith("sleep 120");
    const leg = d.deliver();
    await until(() => freezableRuns().some((r) => r.taskId === d.id), "the check tree is running");

    const stoppedAt = Date.now();
    expect(await stopReviewChecks()).toBe(1);
    await expectLegInFlight((await leg)!);
    // Answered by the stop, not by the end of its 20 s leg.
    expect(Date.now() - stoppedAt).toBeLessThan(15_000);
    const after = await d.read();
    expect(after.status).toBe("in_progress");
    expect(after.checksState).not.toBe("pass");
    expect(after.checksState).not.toBe("fail");
    expect(d.realigns.count).toBe(1);
  }, 60_000);

  test("a leg that arrives while the server goes away waits out its leg and starts no round", async () => {
    const d = await deliveryWith("sleep 120");
    await stopReviewChecks();
    // Answered at once, the client would call again in a tight loop for the
    // whole exit, one of its legs per call; held, the socket close answers it.
    const sentAt = Date.now();
    await expectLegInFlight((await d.deliver(400))!);
    expect(Date.now() - sentAt).toBeGreaterThanOrEqual(350);
    // No realign runs a merge the exit could cut in half.
    expect(d.realigns.count).toBe(0);
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
    await expectLegInFlight((await leg)!);
    expect((await d.read()).status).toBe("in_progress");
    expect(await Bun.file(marker).exists()).toBe(false);
  }, 60_000);

  test("the MCP client rides the reload: [202, interrupted, ECONNREFUSED, 200] ends in review", async () => {
    // The same check on both sides of the restart: slow the first time, so the
    // stop lands on it, and green once measured again by the new server.
    const measured = join(cwd, "measured-once");
    const d = await deliveryWith(`[ -f ${measured} ] || { touch ${measured}; sleep 120; }`);
    let server = d.router;
    const seen: Array<number | string> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const leg = seen.length;
      if (leg === 2) {
        // The old server is gone; the watcher brings a new one up behind it.
        seen.push("ECONNREFUSED");
        _resetReviewChecksStop();
        server = d.boot();
        throw new TypeError("fetch failed: ECONNREFUSED");
      }
      const answer = call(server, init.method!, new URL(url).pathname, JSON.parse(String(init.body)));
      if (leg === 1) {
        // The reload lands while this leg waits on the round: two checkouts per
        // leg, and the second one is past the guard of a server going away.
        await until(() => d.checkouts.count >= 4, "the second leg reached the round");
        expect(await stopReviewChecks()).toBe(1);
      }
      const resp = (await answer)!;
      seen.push(resp.status);
      return resp;
    }) as unknown as typeof fetch;

    const outcome = await callUpdateTask(
      { baseUrl: "http://topics.test", sessionKey: "s1" },
      { task_id: d.id, status: "review", summary: "riassunto della consegna" },
      fetchImpl,
      { legMs: 1_000, maxLegs: 10, backoffMs: [0] },
    );

    expect(seen).toEqual([202, 202, "ECONNREFUSED", 200]);
    expect(outcome).toBe(`task ${d.id} → review`);
    expect((await d.read()).status).toBe("review");
  }, 60_000);
});
