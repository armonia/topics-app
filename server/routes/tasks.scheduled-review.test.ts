/**
 * THE SCHEDULED REVIEW, THROUGH THE REAL WIRING: sweepAutoLand -> the pass -> the shared land verdict.
 *
 * The decisions are pinned in `services/scheduled-review.test.ts` with fake doors. These cases run the
 * router's own sweep over a real card and real service, with only the checkout, the reviewer model and
 * git replaced (`scheduledReviewDoors`): a green card is cleared and lands, a red one goes back to its agent
 * with the file named, a reviewer's reject stops a card whose tests are green.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTasksRouter } from "./tasks";
import { createTaskService, type TaskService } from "../services/tasks";
import { writeWorkflowRules } from "../services/board-workflow";
import type { InspectionReport, SenseVerdict } from "../services/scheduled-review";
import { freshDb, makeCtx, call } from "./tasks-test-support";

const MERGED = {
  status: "merged", commit: "a5f83e0e", branch: "topics/auto", repoPath: "/repo",
  touchedClient: false, touchedServer: true, touchedNative: false,
  landedNotLive: false, checkoutBranch: "main", deliveryDrift: null, realigned: null,
};

let sweep: (() => Promise<number>) | null = null;

describe("the scheduled review, end to end through the sweep", () => {
  let db: Database; let svc: TaskService; let merges: string[];
  const cwd = mkdtempSync(join(tmpdir(), "tasks-scheduled-review-"));
  beforeEach(() => { db = freshDb(); svc = createTaskService(db); merges = []; });
  afterAll(() => { rmSync(cwd, { recursive: true, force: true }); });

  async function deliverAndSweep(doors: { inspect: InspectionReport; sense?: SenseVerdict }, files: string[] = ["server/lib/git-numstat.ts", "server/lib/git-numstat.test.ts"]) {
    const router = createTasksRouter(makeCtx(db, []), undefined, {
      taskCheckoutRef: async () => ({ cwd, commit: "abc1234" }),
      realignForChecks: async () => ({ ok: true, note: null }),
      taskDeliveryRef: async () => ({ branch: "topics/auto", commit: "abc1234", repoPath: "/repo" }),
      ownCommitFiles: async () => files.map((path) => ({ path, added: true })),
      deliveryFiles: async () => files,
      deliveryReferenced: async () => [],
      integrationRepo: async () => "/repo",
      liveTurnCount: () => 0,
      autoLandPollMs: 5,
      scheduledReviewDoors: {
        inspect: async () => doors.inspect,
        sense: async () => doors.sense ?? { kind: "ok", note: "does what the card asks" },
        falseMainClaims: async () => [],
        onMain: async () => false,
      },
      onAutoLand: (api: { sweepAutoLand: () => Promise<number> }) => { sweep = api.sweepAutoLand; },
      autoMerge: {
        tryMerge: async (taskId: string, _t: string, delivery: { beforeMerge?: (sha: string) => Promise<string | null>; commit: string | null }) => {
          const stop = await delivery.beforeMerge?.(delivery.commit ?? "");
          if (stop) return { status: "skipped", code: "auto-land-stopped", reason: stop };
          merges.push(taskId);
          return MERGED;
        },
        buildClient: async () => ({ code: 0, stderr: "" }),
      } as never,
      confirmLandedOnMain: async () => true,
      stampLanding: async () => undefined,
    } as Parameters<typeof createTasksRouter>[2]);
    const task = await (await call(router, "POST", "/api/sessions/s1/tasks", { text: "riordina gli script" }))!.json();
    svc.updateBoardSettings(task.projectId, { dispatchAutoMerge: true, reviewChecks: [{ name: "ok", cmd: "true" }] });
    // The rule is the board's, off by default: this one turns it on.
    db.run("CREATE TABLE IF NOT EXISTS board_workflow_rules (scope TEXT PRIMARY KEY, ci_phase INTEGER, person_paths TEXT, scheduled_review_minutes INTEGER, reviewer_models TEXT, updated_at TEXT NOT NULL)");
    writeWorkflowRules(db, "*", { scheduledReviewMinutes: 10 }, new Date().toISOString());
    // A delivery whose bar is green on its commit (the bar itself is the gate's business, measured elsewhere).
    const bar = JSON.stringify([{ name: "ok", cmd: "true", ok: true, code: 0, ms: 1, timedOut: false }]);
    db.prepare("UPDATE tasks SET status = 'review', delivery_branch = 'topics/auto', delivery_commit = 'abc1234', checks_state = 'pass', checks_commit = 'abc1234', checks_json = ? WHERE id = ?").run(bar, task.id);
    // With the rule on, a green bar alone does not land the card: the review's row is missing.
    await sweep!();
    await Bun.sleep(80);
    expect(merges).toEqual([]);
    expect(svc.get(task.id)!.task.status).toBe("review");
    // The card has waited longer than the interval.
    db.prepare("UPDATE tasks SET review_at = ? WHERE id = ?").run(new Date(Date.now() - 3_600_000).toISOString(), task.id);
    await sweep!();
    await Bun.sleep(200);
    return { id: task.id as string, read: () => svc.get(task.id)! };
  }

  test("a technical card with a green bar and a green review lands with no person in between", async () => {
    const d = await deliverAndSweep({ inspect: { kind: "green", tested: ["server/lib/git-numstat.test.ts"] } });
    expect(d.read().task.checks?.some((r) => r.cmd.startsWith("scheduled-review:") && r.ok)).toBe(true);
    await sweep!(); await Bun.sleep(120);
    expect(merges).toEqual([d.id]);
    expect(d.read().task.status).toBe("done");
  }, 30_000);

  test("a red test goes back to the agent with the file and the test named", async () => {
    const d = await deliverAndSweep({ inspect: { kind: "red", failures: [{ file: "server/lib/git-numstat.test.ts", test: "counts lines" }] } });
    expect(merges).toEqual([]);
    const after = d.read();
    expect(after.task.status).not.toBe("review");
    const said = after.comments.map((c) => c.content).join("\n");
    expect(said).toContain("server/lib/git-numstat.test.ts");
    expect(said).toContain("counts lines");
  }, 30_000);

  test("green tests but a reviewer's reject: the card goes back, nothing lands", async () => {
    const d = await deliverAndSweep({ inspect: { kind: "green", tested: [] }, sense: { kind: "reject", why: "it counts cards in review as taking places" } });
    await sweep!(); await Bun.sleep(80);
    expect(merges).toEqual([]);
    expect(d.read().task.status).not.toBe("review");
    expect(d.read().comments.map((c) => c.content).join("\n")).toContain("taking places");
  }, 30_000);

  test("a delivery in a person's place is never decided by the pass", async () => {
    const d = await deliverAndSweep({ inspect: { kind: "green", tested: [] } }, ["client/src/App.tsx"]);
    await sweep!(); await Bun.sleep(80);
    expect(merges).toEqual([]);
    expect(d.read().task.status).toBe("review");
  }, 30_000);
});
