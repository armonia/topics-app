/**
 * A CARD THAT IS DONE IS NEVER CLAIMED AGAIN.
 *
 * Measured 2026-11-12: a card closed after its remote run kept being picked up
 * by the dispatcher (`dispatchState: starting` on a finished card, an agent
 * starting on work already delivered). The claim is a CAS on `status = 'todo'`.
 */
import { test, expect } from "bun:test";
import { createTaskService } from "./tasks";
import { freshDb as schemaDb } from "./tasks-test-db";


test("claim on a done card changes nothing", () => {
  const db = schemaDb();
  let n = 0;
  const s = createTaskService(db, { now: () => new Date(Date.UTC(2026, 10, 12, 9, n)).toISOString(), uuid: () => `id-${++n}` });
  const t = s.create({ projectId: "topics-app-abc123", text: "Finished remote work" });
  db.run("UPDATE tasks SET status = 'done', dispatch_state = NULL WHERE id = ?", [t.id]);

  expect(s.claim({ taskId: t.id, cap: 5, maxAttempts: 3 })).toBeNull();
  const after = s.get(t.id)!.task;
  expect(after.status).toBe("done");
  expect(after.dispatchState ?? null).toBeNull();
});
