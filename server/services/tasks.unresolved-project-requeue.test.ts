/**
 * Cards parked because their board mapped to no directory come back by
 * themselves once it maps again; every other park is left alone.
 *
 * @covers KANBAN-92
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import type { TaskService } from "./tasks";
import { freshDb, svc, PID } from "./tasks-test-db";
import { UNRESOLVED_PROJECT_PARK_REASON, LEGACY_UNRESOLVED_PROJECT_PARK_REASON } from "../../shared/board";

describe("rientro delle card senza cartella", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db, { t: Date.parse("2026-11-19T23:37:00.000Z") }); });

  const park = (id: string, reason: string) =>
    s.release({ taskId: id, requeue: false, parkState: "blocked", reason });

  test("two parked todos return to todo once the folder resolves, chip gone", () => {
    const a = s.create({ projectId: PID, text: "a", status: "todo" });
    const b = s.create({ projectId: PID, text: "b", status: "todo" });
    park(a.id, UNRESOLVED_PROJECT_PARK_REASON);
    park(b.id, UNRESOLVED_PROJECT_PARK_REASON);
    expect(s.get(a.id)!.task.status).toBe("backlog");
    expect(s.sweepUnresolvedProjectParked({ resolvable: () => false })).toEqual([]);
    expect(s.get(a.id)!.task.status).toBe("backlog");
    const back = s.sweepUnresolvedProjectParked({ resolvable: () => true });
    expect(back.map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
    for (const id of [a.id, b.id]) {
      const t = s.get(id)!.task;
      expect(t.status).toBe("todo");
      expect(t.dispatchState).toBeNull();
      expect(t.dispatchError).toBeNull();
    }
  });

  test("a card parked for another reason stays where it is", () => {
    const a = s.create({ projectId: PID, text: "a", status: "todo" });
    park(a.id, "Il nodo remoto non risponde");
    expect(s.sweepUnresolvedProjectParked({ resolvable: () => true })).toEqual([]);
    expect(s.get(a.id)!.task.status).toBe("backlog");
  });

  test("a card moved to backlog by hand after the park is not requeued", () => {
    const a = s.create({ projectId: PID, text: "a", status: "todo" });
    park(a.id, UNRESOLVED_PROJECT_PARK_REASON);
    s.update({ taskId: a.id, actor: "human", by: "user", patch: { status: "todo" } });
    s.update({ taskId: a.id, actor: "human", by: "user", patch: { status: "backlog" } });
    expect(s.sweepUnresolvedProjectParked({ resolvable: () => true })).toEqual([]);
    expect(s.get(a.id)!.task.status).toBe("backlog");
  });

  test("a hand gesture on a card already in backlog clears the park; the others return", () => {
    const held = s.create({ projectId: PID, text: "held", status: "todo" });
    const other = s.create({ projectId: PID, text: "other", status: "todo" });
    park(held.id, UNRESOLVED_PROJECT_PARK_REASON);
    park(other.id, UNRESOLVED_PROJECT_PARK_REASON);
    s.update({ taskId: held.id, actor: "human", by: "user", patch: { status: "backlog" } });
    expect(s.get(held.id)!.task.dispatchState ?? null).toBeNull();
    s.sweepUnresolvedProjectParked({ resolvable: () => true });
    expect(s.get(held.id)!.task.status).toBe("backlog");
    expect(s.get(other.id)!.task.status).toBe("todo");
  });

  test("a card parked with the legacy text stays parked after the sweep", () => {
    const a = s.create({ projectId: PID, text: "a", status: "todo" });
    park(a.id, LEGACY_UNRESOLVED_PROJECT_PARK_REASON);
    expect(s.sweepUnresolvedProjectParked({ resolvable: () => true })).toEqual([]);
    const t = s.get(a.id)!.task;
    expect(t.status).toBe("backlog");
    expect(t.dispatchState).toBe("blocked");
    s.update({ taskId: a.id, actor: "human", by: "user", patch: { status: "backlog" } });
    expect(s.get(a.id)!.task.dispatchState ?? null).toBeNull();
  });
});
