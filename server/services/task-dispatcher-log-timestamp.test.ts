/**
 * Every stdout line of the dispatcher starts with an ISO timestamp.
 * The server log has no timestamps of its own, so a wait ("held", "waiting
 * for memory") could not be dated afterwards. Reached through `drain`, a public
 * door that logs with no deps.log: the default sink is the one under test.
 *
 * @covers KANBAN-118
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { createTaskService } from "./tasks";
import { createTaskDispatcher, type DispatcherDeps } from "./task-dispatcher";
import { createTaskAttemptStore } from "./task-attempts";
import { dispatcherLogLine } from "./task-dispatcher-support";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL } from "../db/test-schema";

const ISO_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[dispatcher\] /;

function dispatcherWithoutLogDependency() {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE topics (id TEXT PRIMARY KEY)`);
  db.run(TASKS_DDL);
  db.run(TASKS_FK_STUBS_DDL);
  db.run(TASK_LABELS_DDL);
  db.run(`CREATE TABLE task_no_local_check_reservations (task_id TEXT PRIMARY KEY, reservation_gb REAL)`);
  const deps = {
    svc: createTaskService(db),
    attempts: createTaskAttemptStore(db),
    broadcast: () => {},
  } as unknown as DispatcherDeps; // drain() touches none of the other deps
  return createTaskDispatcher(deps);
}

let spy: ReturnType<typeof spyOn>;
beforeEach(() => { spy = spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => { spy.mockRestore(); });

describe("dispatcher log timestamp", () => {
  it("the default sink writes an ISO timestamp before the existing prefix", () => {
    dispatcherWithoutLogDependency().drain("test");
    const line = spy.mock.calls[0]?.[0] as string;
    expect(line).toMatch(ISO_PREFIX);
    expect(line).toContain("drain: nessun turno nuovo fino al riavvio (test)");
  });

  it("the timestamp is the moment of the call", () => {
    const before = Date.now();
    const stamp = dispatcherLogLine("x").split(" ")[0];
    expect(Date.parse(stamp)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(stamp)).toBeLessThanOrEqual(Date.now());
  });
});
