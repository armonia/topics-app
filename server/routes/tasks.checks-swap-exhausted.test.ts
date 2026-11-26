/**
 * AFTER TWO SWAP INTERRUPTIONS, THE TOUCHED-TESTS CHECK TAKES THE CI'S VERDICT.  @covers KANBAN-15
 *
 * `createSwapBrake` used to let a third round of the heavy local check run
 * free once a delivery was "exhausted" (interrupted twice already): the
 * machine kept swapping for a check this board's CI had already measured, and
 * the delivery never landed. With a green CI verdict in hand, a third local
 * round buys nothing: the route now takes the CI's result instead, with a
 * note on the thread, and never starts the command a third time.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTasksRouter } from "./tasks";
import { freshDb, makeCtx, call } from "./tasks-test-support";
import { freezableRuns } from "../services/budget-governor";
import { _resetReviewChecksStop, _resetSwapBrake, createSwapBrake, killCheckTree } from "../services/review-checks-brakes";
import { getDescendantPids } from "../lib/process-tree";
import { E2E_CI_CHECK, type CheckRun } from "../../shared/board";

// Always sleeps, so a THIRD invocation the fallback failed to suppress hangs
// the test instead of quietly passing: touches one new marker per call, so the
// test can tell exactly how many times it started.
const SLEEPER = "if [ ! -f c1 ]; then touch c1; elif [ ! -f c2 ]; then touch c2; elif [ ! -f c3 ]; then touch c3; fi; sleep 120";

describe("a delivery exhausted by the swap brake takes the CI's verdict", () => {
  let db: Database; let broadcasts: unknown[]; let cwd = "";

  beforeEach(() => { db = freshDb(); broadcasts = []; cwd = mkdtempSync(join(tmpdir(), "tasks-swap-exhausted-")); });
  afterEach(() => { _resetReviewChecksStop(); _resetSwapBrake(); rmSync(cwd, { recursive: true, force: true }); });

  function worktree(): void {
    mkdirSync(join(cwd, "node_modules")); // an installed checkout: no dependency install round
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { "test:touched:review": SLEEPER } }));
  }

  async function deliver() {
    const router = createTasksRouter(makeCtx(db, broadcasts), undefined, {
      taskCheckoutRef: async () => ({ cwd, commit: "abc1234" }),
      realignForChecks: async () => ({ ok: true, note: null }),
      ciEvidence: async () => [{
        name: E2E_CI_CHECK.name, cmd: E2E_CI_CHECK.cmd, ok: true, code: 0, ms: 1, timedOut: false, tail: "green",
      } satisfies CheckRun],
    } as Parameters<typeof createTasksRouter>[2]);
    const task = await (await call(router, "POST", "/api/sessions/s1/tasks", { text: "consegna" }))!.json();
    db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(task.id);
    await call(router, "POST", `/api/sessions/s1/tasks/${task.id}/comments`, { content: "fatto" });
    await call(router, "PATCH", `/api/boards/${task.projectId}/settings`, { reviewChecks: [{ name: "ci", cmd: E2E_CI_CHECK.cmd }] });
    const leg = call(router, "PATCH", `/api/sessions/s1/tasks/${task.id}`, { status: "review", summary: "riassunto della consegna", legMs: 20_000 });
    const read = async () => (await (await call(router, "GET", `/api/sessions/s1/tasks/${task.id}`))!.json()).task;
    const comments = async () => (await (await call(router, "GET", `/api/sessions/s1/tasks/${task.id}`))!.json()).comments as { content: string }[];
    return { id: task.id as string, leg, read, comments };
  }

  async function until(cond: () => boolean | Promise<boolean>, what: string): Promise<void> {
    for (let i = 0; i < 400; i++) {
      if (await cond()) return;
      await Bun.sleep(25);
    }
    throw new Error(`never happened: ${what}`);
  }

  /** Waits for a run OTHER than `excludePid` (the restarted round, not the one just killed),
   *  marks its tree as heavy, and kills it through the brake. Returns its pid. */
  async function interruptOnce(taskId: string, excludePid: number): Promise<number> {
    await until(() => freezableRuns().some((r) => r.taskId === taskId && r.pid !== excludePid), "a fresh round is running");
    const run = freezableRuns().find((r) => r.taskId === taskId && r.pid !== excludePid)!;
    await until(async () => (await getDescendantPids(run.pid, { fresh: true })).size > 0, "the command forked");
    run.treeKB = 8e9 / 1024;
    const outcome = createSwapBrake({ kill: killCheckTree, note: () => {}, log: () => {} })
      .tick({ sustained: true, pagesReadBackPerS: 33.6, debtGBPerMin: 8.8, swapPct: null, coveredMs: 60_000 }, freezableRuns(), Number.NEGATIVE_INFINITY);
    expect(outcome.interrupted, "the brake killed this round").toBe(true);
    await until(() => !freezableRuns().some((r) => r.pid === run.pid), "the killed tree was reaped");
    return run.pid;
  }

  test("two interruptions, a green CI, and a third round never starts: pass with a note", async () => {
    worktree();
    const d = await deliver();
    const pid1 = await interruptOnce(d.id, 0);
    await interruptOnce(d.id, pid1); // the restarted round, same commit

    await until(async () => (await d.read()).status === "review", "the fallback let the card into review");
    const task = await d.read();
    expect(task.checksState).toBe("pass");
    expect(existsSync(join(cwd, "c3")), "no third round ever started the command").toBe(false);

    const said = (await d.comments()).map((c) => c.content).join("\n");
    expect(said).toMatch(/swap/i);
    await d.leg;
  }, 60_000);
});
