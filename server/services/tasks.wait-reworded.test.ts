/**
 * A WAIT REWORDED IS STILL THE SAME WAIT, FOR THE CLOCK.
 *
 * Card 60c4b56a: five waits in three days (240, 480, 720, 1440, 1440 min)
 * on the same condition, every time with different words. `waitReasonKey`
 * compares text, so each new sentence restarted the series at streak 1 and
 * `wait_since` = now: neither cap ever fired and nobody was told.
 * The series clock now keeps running while the card is already waiting,
 * whatever the reason; the per-reason streak count stays as it was.
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import type { TaskService } from "./tasks";
import { freshDb, svc, PID } from "./tasks-test-db";
import { PARKED_WAITED_OUT } from "../../shared/board";

const T0 = Date.parse("2026-11-12T09:00:00.000Z");
const ORA = 3_600_000;

describe("attesa riformulata", () => {
  let db: Database; let s: TaskService;
  const clock = { t: T0 };
  beforeEach(() => { clock.t = T0; db = freshDb(); s = svc(db, clock); });

  test("due ragioni diverse a 5 ore di distanza: la seconda parcheggia", () => {
    const t = s.create({ projectId: PID, text: "C2 dopo C1", status: "todo" });
    s.claim({ taskId: t.id, cap: 5, maxAttempts: 2 });
    s.deferForWait({ taskId: t.id, reason: "C2 dipende da C1, aspetto che chiuda", minutes: 240, by: "claude" });
    expect(s.get(t.id)!.task.status).toBe("todo");

    clock.t += 5 * ORA;
    s.claim({ taskId: t.id, cap: 5, maxAttempts: 2 });
    s.deferForWait({ taskId: t.id, reason: "C1 (7e64f79d) non ancora chiusa", minutes: 480, by: "claude" });

    const after = s.get(t.id)!.task;
    expect(after.dispatchState).toBe(PARKED_WAITED_OUT);
    expect(after.status).toBe("backlog");
  });

  test("ragione nuova dentro il tetto: la serie tiene l'orologio, il conteggio riparte", () => {
    const t = s.create({ projectId: PID, text: "C2 dopo C1", status: "todo" });
    s.claim({ taskId: t.id, cap: 5, maxAttempts: 2 });
    s.deferForWait({ taskId: t.id, reason: "prima frase", minutes: 15, by: "claude" });
    const first = s.get(t.id)!.task.waitSince;

    clock.t += 1 * ORA;
    s.claim({ taskId: t.id, cap: 5, maxAttempts: 2 });
    s.deferForWait({ taskId: t.id, reason: "seconda frase, altre parole", minutes: 15, by: "claude" });

    const after = s.get(t.id)!.task;
    expect(after.dispatchState).toBe("waiting");
    expect(after.waitSince).toBe(first);
    expect(after.waitStreak).toBe(1);
  });
});
