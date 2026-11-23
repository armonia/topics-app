/**
 * The board side of the security alerts: a red check opens one card, a green one closes it.
 *
 * @covers MACHINE-07
 */
import { beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckStatus, MachineSecurity } from "../../shared/machine-health";
import { createTaskService } from "../services/tasks";
import { freshDb, PID } from "../services/tasks-test-db";
import { createSecurityAlertsRound } from "./machine-security-alerts";

let db: Database;
let dir: string;
beforeEach(() => {
  db = freshDb();
  dir = mkdtempSync(join(tmpdir(), "sec-alerts-"));
});

const machines = (status: CheckStatus, id = "m1") => ({
  [id]: { name: "Node one", security: { checked_at: 1, status: "ok", checks: [{ key: "access", status, detail: "port open" }] } as MachineSecurity },
});

function setup(projectId: string | null, now = () => Date.now()) {
  const svc = createTaskService(db);
  const round = createSecurityAlertsRound({ db, svc, broadcast: () => {}, projectId: () => projectId, statePath: join(dir, "state.json"), now });
  const cards = () => db.query("SELECT status FROM tasks WHERE claude_task_id LIKE 'security:%'").all() as Array<{ status: string }>;
  return { round, cards };
}

test("the card stays on the hub, the only machine that reaches what it measured", async () => {
  const { round } = setup(PID);
  await round(machines("problem"));
  const row = db.query("SELECT stay_local, machine_id FROM tasks WHERE claude_task_id LIKE 'security:%'").get() as { stay_local: number; machine_id: string | null };
  expect(row).toEqual({ stay_local: 1, machine_id: null });
  rmSync(dir, { recursive: true, force: true });
});

test("two red rounds make one card, green closes it, red again opens a new one", async () => {
  const { round, cards } = setup(PID);
  await round(machines("problem"));
  await round(machines("problem"));
  expect(cards().map((c) => c.status)).toEqual(["todo"]);
  await round(machines("ok"));
  expect(cards().map((c) => c.status)).toEqual(["done"]);
  await round(machines("problem"));
  expect(cards().map((c) => c.status)).toEqual(["done", "todo"]);
  rmSync(dir, { recursive: true, force: true });
});

test("an ssh server, whose id carries an @, keeps one card across red rounds", async () => {
  // A clock that moves: two rounds in the same millisecond would share the
  // idempotency key and hide a second card.
  let t = 1_000_000;
  const { round, cards } = setup(PID, () => (t += 300_000));
  const ssh = "ssh:root@203.0.113.7";
  await round(machines("problem", ssh));
  await round(machines("problem", ssh));
  expect(cards().map((c) => c.status)).toEqual(["todo"]);
  await round(machines("ok", ssh));
  expect(cards().map((c) => c.status)).toEqual(["done"]);
  rmSync(dir, { recursive: true, force: true });
});

test("with no board chosen no card is born", async () => {
  const { round, cards } = setup(null);
  await round(machines("problem"));
  expect(cards()).toEqual([]);
  rmSync(dir, { recursive: true, force: true });
});
