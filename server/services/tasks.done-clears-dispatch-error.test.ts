/**
 * A CLOSED CARD DOES NOT WEAR A FAILURE.
 *
 * `dispatch_error` says why the LAST turn did not get there ("the turn ended
 * without reaching review after 2 attempts"). True while the card is still
 * trying; a lie the moment it is done, because the work landed and somebody
 * approved it.
 *
 * Nothing cleared it on the way to done - the `put(dispatch_error, null)` calls
 * all sit on the todo/backlog branches - and the chip that reads it never
 * looked at the status. On the live DB: 44 non-archived done cards carrying a
 * rose 'stopped' badge.
 *
 * Two guards on the same fact, and this file pins the one AT THE SOURCE: the
 * client guard (`stoppedChip.ts`) stops a stale row from drawing, this stops
 * the row from existing. One without the other is a fix that lasts until the
 * next surface reads the column.
 *
 * @covers KANBAN-07
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createTaskService, type TaskService } from "./tasks";
import { freshDb } from "./tasks-test-db";

const PID = "topics-app-abc123";
const STOPPED = "Il turno è terminato senza arrivare a review dopo 2 tentativi.";   // allow-italian: the exact sentence the rows carry

function svc(db: Database): TaskService {
  let n = 0;
  let clock = 0;
  return createTaskService(db, {
    now: () => new Date(Date.UTC(2026, 8, 4, 9, clock++)).toISOString(),
    uuid: () => `id-${++n}`,
  });
}

const mv = (s: TaskService, taskId: string, status: string) =>
  s.update({ taskId, actor: "human", by: "user", patch: { status: status as never } });

describe("una card chiusa non conserva il motivo per cui si era fermata", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  test("review → done: il motivo si spegne nella stessa scrittura", () => {
    const t = s.create({ projectId: PID, text: "Una card che aveva mollato" });
    mv(s, t.id, "todo");
    s.setDispatchState({ taskId: t.id, state: "failed", error: STOPPED });
    mv(s, t.id, "review");
    expect(s.get(t.id)!.task.dispatchError).toBe(STOPPED);

    // In the task the write RETURNS, not "at the next reconcile": that is what
    // the board draws the instant the card is approved.
    const closed = mv(s, t.id, "done");
    expect(closed.dispatchError).toBeNull();
    expect(s.get(t.id)!.task.dispatchError).toBeNull();
  });

  test("da qualunque colonna arrivi: è la destinazione a decidere", () => {
    for (const from of ["todo", "backlog", "in_progress"]) {
      const t = s.create({ projectId: PID, text: `da ${from}` });
      mv(s, t.id, from);
      s.setDispatchState({ taskId: t.id, state: "failed", error: STOPPED });
      expect(mv(s, t.id, "done").dispatchError).toBeNull();
    }
  });

  test("nelle altre colonne il motivo è ancora vero, e resta", () => {
    // The half that keeps the rule honest: this is not "clear the column",
    // it is "a closed card has no turn left to explain". A card in review with
    // a failed turn behind it is telling the reviewer something real.
    const t = s.create({ projectId: PID, text: "ancora in ballo" });
    mv(s, t.id, "todo");
    s.setDispatchState({ taskId: t.id, state: "failed", error: STOPPED });
    expect(mv(s, t.id, "review").dispatchError).toBe(STOPPED);
    expect(s.get(t.id)!.task.dispatchError).toBe(STOPPED);
  });

  test("riaperta dopo la chiusura, non si riesuma il vecchio motivo", () => {
    const t = s.create({ projectId: PID, text: "riaperta" });
    mv(s, t.id, "todo");
    s.setDispatchState({ taskId: t.id, state: "failed", error: STOPPED });
    mv(s, t.id, "done");
    expect(mv(s, t.id, "todo").dispatchError).toBeNull();
  });
});
