/**
 * The daily dependency audit turns into a card: a red run opens one, a green run closes it.
 *
 * @covers SEC-01
 */
import { expect, test } from "bun:test";
import { createTaskService } from "../services/tasks";
import { freshDb, PID } from "../services/tasks-test-db";
import { createDependencyAuditRound, type AuditRun } from "./dependency-audit-alert";

function setup(projectId: string | null) {
  const db = freshDb();
  let run: AuditRun | null = null;
  const round = createDependencyAuditRound({
    db, svc: createTaskService(db), broadcast: () => {}, projectId: () => projectId, latestRun: async () => run, now: () => Date.now(),
  });
  const cards = () => db.query("SELECT status FROM tasks WHERE claude_task_id LIKE 'security:dependency-audit%'").all() as Array<{ status: string }>;
  return { round, cards, set: (r: AuditRun | null) => { run = r; } };
}
const red: AuditRun = { conclusion: "failure", url: "https://github.com/x/y/actions/runs/1" };
const green: AuditRun = { conclusion: "success", url: "https://github.com/x/y/actions/runs/2" };

test("a red run opens one card, the next round adds none, green closes it", async () => {
  const { round, cards, set } = setup(PID);
  set(red);
  await round();
  await round();
  expect(cards().map((c) => c.status)).toEqual(["todo"]);
  set(green);
  await round();
  expect(cards().map((c) => c.status)).toEqual(["done"]);
  await round();
  expect(cards()).toHaveLength(1);
});

test("no reading or no board changes nothing", async () => {
  const a = setup(PID);
  a.set(null);
  await a.round();
  expect(a.cards()).toEqual([]);
  const b = setup(null);
  b.set(red);
  await b.round();
  expect(b.cards()).toEqual([]);
});
