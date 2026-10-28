/**
 * WHO OPENED A CARD, AND THE CARD NOBODY OWNS.
 *
 * Two pieces of the same card (f2289637). `created_by` is the label that says
 * whose a card is, so who closes it: on 2026-10-28 the cards Jarvis opened sat
 * in review and nothing on the board told whose they were. `sweepUnownedBacklog`
 * is the event for whoever coordinates: a card opened by an agent or a schedule
 * that stays in backlog ten minutes with nobody on it.
 * @covers KANBAN-05
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import type { TaskService } from "./tasks";
import { freshDb, svc, PID } from "./tasks-test-db";
import { UNOWNED_BACKLOG_MS } from "../../shared/created-by";

const T0 = Date.parse("2026-10-28T10:00:00.000Z");
const MIN = 60_000;

describe("created_by: the label of who opened the card", () => {
  let db: Database; let s: TaskService;
  const clock = { t: T0 };
  beforeEach(() => { clock.t = T0; db = freshDb(); s = svc(db, clock); });

  test("is stored as given and travels on the card", () => {
    const a = s.create({ projectId: PID, text: "from jarvis", createdBy: "agent:jarvis" });
    const c = s.create({ projectId: PID, text: "from a schedule", createdBy: "cron:scheduled-card" });
    const h = s.create({ projectId: PID, text: "from a person", createdBy: "human" });
    expect(a.createdBy).toBe("agent:jarvis");
    expect(c.createdBy).toBe("cron:scheduled-card");
    expect(h.createdBy).toBe("human");
    expect(s.get(a.id)!.task.createdBy).toBe("agent:jarvis");
    expect(s.list({ scope: "project", projectId: PID }).map((t) => t.createdBy).sort())
      .toEqual(["agent:jarvis", "cron:scheduled-card", "human"]);
  });

  test("omitted or malformed means NULL, never a made-up author", () => {
    expect(s.create({ projectId: PID, text: "internal path" }).createdBy).toBeNull();
    expect(s.create({ projectId: PID, text: "garbage", createdBy: "root; DROP TABLE tasks" }).createdBy).toBeNull();
    expect(s.create({ projectId: PID, text: "wrong kind", createdBy: "robot:x" }).createdBy).toBeNull();
  });
});

describe("sweepUnownedBacklog: backlog past ten minutes with nobody on it", () => {
  let db: Database; let s: TaskService;
  const clock = { t: T0 };
  beforeEach(() => { clock.t = T0; db = freshDb(); s = svc(db, clock); });

  const open = (extra: Record<string, unknown> = {}) =>
    s.create({ projectId: PID, text: "card", status: "backlog", createdBy: "agent:jarvis", ...extra });

  test("ten minutes is the threshold: before it nothing, after it the card, once", () => {
    const t = open();
    clock.t += UNOWNED_BACKLOG_MS - MIN;
    expect(s.sweepUnownedBacklog()).toEqual([]);

    clock.t += MIN + 1000;
    const hit = s.sweepUnownedBacklog();
    expect(hit.map((x) => x.id)).toEqual([t.id]);

    // The second pass is silent: the stamp survives, the poll runs every 10 s.
    expect(s.sweepUnownedBacklog()).toEqual([]);
    clock.t += 60 * MIN;
    expect(s.sweepUnownedBacklog()).toEqual([]);
  });

  test("the stamp is not a touch: updated_at stays where it was", () => {
    const t = open();
    const before = s.get(t.id)!.task.updatedAt;
    clock.t += 11 * MIN;
    s.sweepUnownedBacklog();
    expect(s.get(t.id)!.task.updatedAt).toBe(before);
  });

  test("a card touched after the alert re-arms: a new round, a new alert", () => {
    const t = open();
    clock.t += 11 * MIN;
    expect(s.sweepUnownedBacklog()).toHaveLength(1);

    clock.t += 1000; // the touch lands after the stamp, as it does in real time
    s.update({ taskId: t.id, actor: "human", by: "user", patch: { text: "card, reworded" } });
    clock.t += 5 * MIN;
    expect(s.sweepUnownedBacklog()).toEqual([]);
    clock.t += 6 * MIN;
    expect(s.sweepUnownedBacklog().map((x) => x.id)).toEqual([t.id]);
  });

  test("a card with an owner is not reported", () => {
    const assigned = open({ assignedTo: "jarvis" });
    const blocker = open();
    const blocked = open({ blockedByTaskId: blocker.id });
    const parent = open();
    const step = s.create({ projectId: PID, text: "step", status: "backlog", createdBy: "agent:jarvis", parentTaskId: parent.id });
    clock.t += 11 * MIN;
    const ids = s.sweepUnownedBacklog().map((x) => x.id).sort();
    expect(ids).toEqual([blocker.id, parent.id].sort());
    expect(ids).not.toContain(assigned.id);
    expect(ids).not.toContain(blocked.id);
    expect(ids).not.toContain(step.id);
  });

  test("a person's own parking and the columns that have a runner are left alone", () => {
    open({ createdBy: "human", text: "mine" });
    open({ createdBy: undefined, text: "no author" });
    open({ status: "todo", text: "queued" });
    const done = open({ text: "to archive" });
    s.archive({ taskId: done.id });
    clock.t += 11 * MIN;
    expect(s.sweepUnownedBacklog()).toEqual([]);
  });

  test("cards already in backlog when the migration ran do not fire together", () => {
    // The migration stamps them; here the equivalent: a stamp ahead of updated_at.
    const t = open();
    db.run("UPDATE tasks SET unowned_alerted_at = ? WHERE id = ?", [new Date(T0 + 1000).toISOString(), t.id]);
    clock.t += 3 * 60 * MIN;
    expect(s.sweepUnownedBacklog()).toEqual([]);
  });
});
