/**
 * THE "QUEUED" CHIP GOES OUT WITH THE GESTURE THAT TAKES THE CARD OUT OF TODO.
 *
 * `queued` promises one thing: "the dispatcher will pick you up shortly". But
 * the claim only fishes among `todo` rows, so the moment the card leaves that
 * column the promise has expired — and the chip stayed lit, offering "Stop",
 * a command to interrupt an agent that never started.
 *
 * The in-memory cancel already existed (the dispatcher's `onLeaveTodo`) but it
 * only covers the case where the grace timer is still there: after a server
 * restart, or after a tick that wrote `queued` without winning the slot, there
 * is nothing left to cancel. That is why the rule lives in the WRITE, where it
 * does not depend on what the process happens to remember.
 *
 * The other half, which this file pins just as hard: `starting` and `working`
 * are NOT touched. A card dragged into Backlog while the agent runs has a live
 * turn, and "Stop" is the one command that matters.
 *
 * WHERE THIS FILE COMES FROM, and the correction inside it. It was written on
 * 2026-08-19 on branch `topics/meek-blizzard`, the card was closed, and the
 * audit of `done` cards found that card marked `unlanded` with its test file
 * nowhere on main. The obvious reading — "the card claimed a behaviour the
 * product does not have" — was WRONG, and the way it was caught is the reason
 * this paragraph exists: re-adding the rule made only ONE of five tests go
 * from red to green, which means four of them were already passing. Somebody
 * had landed the same rule later, by another route, in another branch of the
 * same function.
 *
 * What had NOT landed is one line: the chip went out and its REASON stayed.
 * `dispatch_error` is the sentence the badge says out loud, and a row still
 * carrying it with no queue behind it is the same lie in smaller print. That is the only behavioural change this file guards that main did
 * not already have — and without running the tests against the un-fixed code,
 * the whole file would have been re-landed as a duplicate that proves nothing.
 *
 * @covers KANBAN-07
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createTaskService, type TaskService } from "./tasks";
import { freshDb } from "./tasks-test-db";

const PID = "topics-app-abc123";

function svc(db: Database): TaskService {
  let n = 0;
  let clock = 0;
  return createTaskService(db, {
    now: () => new Date(Date.UTC(2026, 7, 19, 9, clock++)).toISOString(),
    uuid: () => `id-${++n}`,
  });
}

/** Moving a card between columns: `update` always wants to know who moved it. */
const mv = (s: TaskService, taskId: string, status: string) =>
  s.update({ taskId, actor: "human", by: "user", patch: { status: status as never } });

describe("il chip «in coda» non sopravvive all'uscita da Todo", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  test("todo → backlog: chip e motivo si spengono nella stessa scrittura", () => {
    const t = s.create({ projectId: PID, text: "Una card in coda" });
    mv(s, t.id, "todo");
    // What the dispatcher writes when it puts the card in line.
    s.setDispatchState({ taskId: t.id, state: "queued", error: "tetto agenti pieno" });
    expect(s.get(t.id)!.task.dispatchState).toBe("queued");

    const after = mv(s, t.id, "backlog");
    // In the task the write RETURNS, not "at the next reconcile": that is what
    // the client draws right after the drag.
    expect(after.dispatchState).toBeNull();
    expect(after.dispatchError).toBeNull();
    expect(s.get(t.id)!.task.dispatchState).toBeNull();
  });

  test("vale per ogni colonna che non è Todo, non solo per Backlog", () => {
    for (const dest of ["backlog", "in_progress", "review"]) {
      const t = s.create({ projectId: PID, text: `verso ${dest}` });
      mv(s, t.id, "todo");
      s.setDispatchState({ taskId: t.id, state: "queued" });
      expect(mv(s, t.id, dest).dispatchState).toBeNull();
    }
  });

  test("un turno VIVO non si nasconde: starting e working restano", () => {
    for (const chip of ["starting", "working"]) {
      const t = s.create({ projectId: PID, text: `agent ${chip}` });
      mv(s, t.id, "todo");
      s.setDispatchState({ taskId: t.id, state: chip });
      // Dragged into Backlog while the agent runs: the chip stays, and with it
      // the only command that is any use ("Stop").
      expect(mv(s, t.id, "backlog").dispatchState).toBe(chip);
    }
  });

  test("gli altri chip descrivono un parcheggio, non una coda: non si toccano", () => {
    for (const chip of ["waiting", "failed", "blocked", "stopped"]) {
      const t = s.create({ projectId: PID, text: `chip ${chip}` });
      mv(s, t.id, "todo");
      s.setDispatchState({ taskId: t.id, state: chip });
      expect(mv(s, t.id, "backlog").dispatchState).toBe(chip);
    }
  });

  test("todo → todo non è un'uscita: la card in coda ci resta", () => {
    const t = s.create({ projectId: PID, text: "resta in coda" });
    mv(s, t.id, "todo");
    s.setDispatchState({ taskId: t.id, state: "queued" });
    // A PATCH that touches something else and passes the same status through
    // must not drain the queue: the dispatcher is still watching that row.
    const after = s.update({ taskId: t.id, actor: "agent", by: "agent", patch: { status: "todo" as never } });
    expect(after.dispatchState).toBe("queued");
  });
});
