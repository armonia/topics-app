/**
 * A CARD THAT IS DONE IS NEVER PICKED UP AGAIN.
 *
 * Measured 2026-11-12 on 403aad1f: closed at 13:04:04 while a remote attempt
 * was still `queued`/`starting`, reopened at 13:05:44 with `reopenedBy:
 * dispatcher` / `reopenedActor: system` (only `release({ requeue })` writes
 * that), claimed again, `dispatchAttempts` up to 4, and the restarted agent
 * asked whether to close it. The claim CAS on `status = 'todo'` was never the
 * hole: the requeue that put the done card back in todo was.
 */
import { test, expect } from "bun:test";
import { createTaskService } from "./tasks";
import { freshDb as schemaDb } from "./tasks-test-db";

function service() {
  const db = schemaDb();
  let n = 0;
  const s = createTaskService(db, { now: () => new Date(Date.UTC(2026, 10, 12, 9, n)).toISOString(), uuid: () => `id-${++n}` });
  return { db, s };
}

test("claim on a done card changes nothing", () => {
  const { db, s } = service();
  const t = s.create({ projectId: "topics-app-abc123", text: "Finished remote work" });
  db.run("UPDATE tasks SET status = 'done', dispatch_state = NULL WHERE id = ?", [t.id]);

  expect(s.claim({ taskId: t.id, cap: 5, maxAttempts: 3 })).toBeNull();
  const after = s.get(t.id)!.task;
  expect(after.status).toBe("done");
  expect(after.dispatchState ?? null).toBeNull();
});

for (const inFlight of ["queued", "starting"] as const) {
  test(`done while an attempt is ${inFlight}: the dispatcher's requeue and the next claim leave it done`, () => {
    const { db, s } = service();
    const t = s.create({ projectId: "topics-app-abc123", text: "Remote work closed mid-attempt" });
    // The attempt in flight, then the human closes the card under it.
    db.run("UPDATE tasks SET status = 'in_progress', dispatch_state = ?, dispatch_attempts = 3 WHERE id = ?", [inFlight, t.id]);
    db.run("UPDATE tasks SET status = 'done' WHERE id = ?", [t.id]);

    // The remote-run path that reopened 403aad1f: a requeue with refund.
    s.release({ taskId: t.id, requeue: true, rollbackAttempt: true, reason: "run returned to the queue", by: "dispatcher" });
    expect(s.claim({ taskId: t.id, cap: 5, maxAttempts: 9 })).toBeNull();

    const after = s.get(t.id)!.task;
    expect(after.status).toBe("done");
    expect(after.dispatchState ?? null).toBeNull();
    expect(after.reopenedBy ?? null).toBeNull();
    expect(after.dispatchAttempts).toBe(3);
  });
}

test("a park on a done card does not send it to backlog either", () => {
  const { db, s } = service();
  const t = s.create({ projectId: "topics-app-abc123", text: "Remote work closed mid-attempt" });
  db.run("UPDATE tasks SET status = 'done', dispatch_state = 'starting' WHERE id = ?", [t.id]);

  s.release({ taskId: t.id, requeue: false, parkState: "failed", reason: "node lost", by: "dispatcher" });

  const after = s.get(t.id)!.task;
  expect(after.status).toBe("done");
  expect(after.dispatchState ?? null).toBeNull();
});
