/**
 * The scheduled review's gate in the CI phase, and the answer that keeps its question: both live in
 * `createCiPhase`, so they are pinned on it directly with a real service and no git.
 *
 * @covers LAND-17
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createCiPhase } from "./tasks-ci-phase";
import { createTaskService, type TaskService } from "../services/tasks";
import { writeWorkflowRules } from "../services/board-workflow";
import { scheduledReviewCmd } from "../services/auto-land";
import { UNIT_CI_CHECK } from "../../shared/board-contract";
import { freshDb } from "./tasks-test-support";

let db: Database; let svc: TaskService;
beforeEach(() => { db = freshDb(); svc = createTaskService(db); });

function setup(over: { live?: boolean } = {}) {
  const landed: string[] = [];
  const phase = createCiPhase({
    svc, db, broadcast: () => undefined,
    cardTurnIsLive: () => over.live ?? false,
    landDirect: (_p, id) => { landed.push(id); return null; },
    whenLanded: () => null,
    tryAutoLand: async () => undefined,
    integrationRepo: async () => "/repo",
    integrationMeasure: async (_p, ids) => ({ measured: ids, conflicts: [], verdict: "pass" }),
    integrationCollectMs: 1,
  });
  const task = svc.create({ text: "tidy the scripts", projectId: "p1" } as never);
  return { phase, landed, task };
}

function reviewCard(id: string, commit: string, rows: Array<{ cmd: string; ok: boolean }>) {
  const bar = JSON.stringify(rows.map((r) => ({ name: r.cmd, cmd: r.cmd, ok: r.ok, code: r.ok ? 0 : 1, ms: 1, timedOut: false })));
  db.prepare("UPDATE tasks SET status = 'review', delivery_branch = 'topics/x', delivery_commit = ?, checks_state = 'pass', checks_commit = ?, checks_json = ? WHERE id = ?").run(commit, commit, bar, id);
}

function turnOnPhase(projectId: string, reviewMinutes: number) {
  db.run("CREATE TABLE IF NOT EXISTS board_workflow_rules (scope TEXT PRIMARY KEY, ci_phase INTEGER, person_paths TEXT, scheduled_review_minutes INTEGER, reviewer_models TEXT, updated_at TEXT NOT NULL)");
  writeWorkflowRules(db, "*", { ciPhase: "before", scheduledReviewMinutes: reviewMinutes }, new Date().toISOString());
  svc.updateBoardSettings(projectId, { dispatchAutoMerge: true, reviewChecks: [{ name: "unit", cmd: UNIT_CI_CHECK.cmd }] });
}

describe("CI phase land with the scheduled review on", () => {
  test("an automatic decision on a commit the review has not cleared does not land", async () => {
    const { phase, landed, task } = setup();
    turnOnPhase(task.projectId, 120);
    reviewCard(task.id, "abc1234def", [{ cmd: UNIT_CI_CHECK.cmd, ok: true }]);
    expect(phase.enterCiPhase(task.projectId, task.id, { recheck: () => null })).toBe(true);
    await Bun.sleep(150);
    expect(landed).toEqual([]);
    expect(svc.get(task.id)!.task.landIntent ?? null).toBeNull();
    expect(svc.get(task.id)!.task.status).toBe("review");
  });

  test("the same card with the review's row on its commit lands", async () => {
    const { phase, landed, task } = setup();
    turnOnPhase(task.projectId, 120);
    reviewCard(task.id, "abc1234def", [{ cmd: UNIT_CI_CHECK.cmd, ok: true }, { cmd: scheduledReviewCmd("abc1234def"), ok: true }]);
    phase.enterCiPhase(task.projectId, task.id, { recheck: () => null });
    await Bun.sleep(150);
    expect(landed).toEqual([task.id]);
  });

  test("a row for an earlier commit does not clear a newer one", async () => {
    const { phase, landed, task } = setup();
    turnOnPhase(task.projectId, 120);
    reviewCard(task.id, "bbb2222def", [{ cmd: UNIT_CI_CHECK.cmd, ok: true }, { cmd: scheduledReviewCmd("aaa1111def"), ok: true }]);
    phase.enterCiPhase(task.projectId, task.id, { recheck: () => null });
    await Bun.sleep(150);
    expect(landed).toEqual([]);
  });

  test("a person's land is not gated by the review", async () => {
    const { phase, landed, task } = setup();
    turnOnPhase(task.projectId, 120);
    reviewCard(task.id, "abc1234def", [{ cmd: UNIT_CI_CHECK.cmd, ok: true }]);
    phase.enterCiPhase(task.projectId, task.id);
    await Bun.sleep(150);
    expect(landed).toEqual([task.id]);
  });
});

describe("the reviewer's answer to the agent's question", () => {
  test("a send-back that is refused leaves the question with the person", () => {
    const { phase, task } = setup({ live: true });
    reviewCard(task.id, "abc1234def", []);
    svc.update({ taskId: task.id, actor: "agent", patch: { humanAsk: "reuse the helper or write a new one?" } } as never);
    expect(phase.bounceWithReason(task.projectId, task.id, "use the helper", { as: "answer" })).toBe(false);
    expect(svc.get(task.id)!.task.humanAsk).toContain("reuse the helper");
    expect(svc.get(task.id)!.task.status).toBe("review");
  });

  test("a send-back that happens clears the question and says the answer as it is", () => {
    const { phase, task } = setup();
    reviewCard(task.id, "abc1234def", []);
    db.prepare("UPDATE tasks SET human_ask = ? WHERE id = ?").run("reuse the helper or write a new one?", task.id);
    expect(phase.bounceWithReason(task.projectId, task.id, "Risposta del revisore alla tua domanda: use the helper", { as: "answer" })).toBe(true);
    const after = svc.get(task.id)!;
    expect(after.task.humanAsk ?? null).toBeNull();
    expect(after.task.status).not.toBe("review");
    expect(after.comments.map((c) => c.content).join("\n")).toContain("use the helper");
  });

  test("a scheduled send-back uses its own words, not the red bar's", () => {
    const { phase, task } = setup();
    reviewCard(task.id, "abc1234def", []);
    expect(phase.bounceWithReason(task.projectId, task.id, "tests red in a.test.ts", { as: "scheduled" })).toBe(true);
    const said = svc.get(task.id)!.comments.map((c) => c.content).join("\n");
    expect(said).toContain("ripasso a orario");
    expect(said).not.toContain("i check sono rossi");
  });
});
