/**
 * The daily dependency audit turns into a card: a red run opens one, a green run closes it.
 *
 * @covers SEC-01
 */
import { expect, test } from "bun:test";
import { createTaskService } from "../services/tasks";
import { freshDb, PID } from "../services/tasks-test-db";
import { createDependencyAuditRound, parseGithubRepo, type AuditRun } from "./dependency-audit-alert";

function setup(projectId: string | null) {
  const db = freshDb();
  let run: AuditRun | null = null;
  const svc = createTaskService(db);
  const round = createDependencyAuditRound({
    db, svc, broadcast: () => {}, projectId: () => projectId, latestRun: async () => run,
  });
  const cards = () => db.query("SELECT id, text, status FROM tasks WHERE claude_task_id LIKE 'security:dependency-audit%'").all() as Array<{ id: string; text: string; status: string }>;
  const tick = () => round();
  return { db, svc, tick, cards, set: (r: AuditRun | null) => { run = r; } };
}
const red: AuditRun = { id: 1, conclusion: "failure", url: "https://github.com/x/y/actions/runs/1" };
const green: AuditRun = { id: 2, conclusion: "success", url: "https://github.com/x/y/actions/runs/2" };

test("a red run opens one card, the next round adds none, green closes it", async () => {
  const { tick, cards, set } = setup(PID);
  set(red);
  await tick();
  await tick();
  expect(cards().map((c) => c.status)).toEqual(["todo"]);
  set(green);
  await tick();
  expect(cards().map((c) => c.status)).toEqual(["done"]);
  await tick();
  expect(cards()).toHaveLength(1);
});

test("a card closed by hand does not come back for the same red run, a new red run opens one", async () => {
  const { tick, cards, svc, set } = setup(PID);
  set(red);
  await tick();
  svc.update({ taskId: cards()[0]!.id, actor: "human", by: "system", projectId: PID, patch: { status: "done" } });
  await tick();
  await tick();
  expect(cards().map((c) => c.status)).toEqual(["done"]);
  set({ ...red, id: 3 });
  await tick();
  expect(cards().map((c) => c.status).sort()).toEqual(["done", "todo"]);
});

test("an open card absorbs a new red run: still one card until green", async () => {
  const { tick, cards, set } = setup(PID);
  set(red);
  await tick();
  set({ ...red, id: 3 });
  await tick();
  expect(cards().map((c) => c.status)).toEqual(["todo"]);
});

test("a run that never started opens a card that says so", async () => {
  const { tick, cards, set } = setup(PID);
  set({ id: 4, conclusion: "startup_failure", url: "u" });
  await tick();
  expect(cards()[0]!.text).toContain("did not run");
});

test("no reading or no board changes nothing", async () => {
  const a = setup(PID);
  a.set(null);
  await a.tick();
  expect(a.cards()).toEqual([]);
  const b = setup(null);
  b.set(red);
  await b.tick();
  expect(b.cards()).toEqual([]);
});

test("the repo comes out of a github remote", () => {
  expect(parseGithubRepo("git@github.com:o/r.git")).toBe("o/r");
  expect(parseGithubRepo("https://github.com/o/r")).toBe("o/r");
  expect(parseGithubRepo("https://example.com/o/r.git")).toBeNull();
});
