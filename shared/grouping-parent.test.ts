/**
 * @covers KANBAN-105
 */
import { describe, expect, test } from "bun:test";
import { freshDb } from "../server/routes/tasks-test-support";
import { PARKED_CHILDREN_CANDIDATES_SQL } from "../server/lib/task-timer-reads";
import { isGroupingParent, type GroupingParentFields } from "./grouping-parent";

const untouched: Required<GroupingParentFields> = { status: "backlog", dispatch_attempts: 0, in_progress_at: null, delivered_by: null, delivered_reason: null, dispatch_state: null };
// What the parked-children rake writes when it asks: a system delivery with its own reason, and the chip.
const askedByRake = { delivered_by: "system", delivered_reason: "parked_children" };

describe("isGroupingParent", () => {
  test("an untouched backlog card with open children groups them", () => {
    expect(isGroupingParent(untouched, 2)).toBe(true);
    expect(isGroupingParent(untouched, 0)).toBe(false);
  });

  test("any trace of a turn makes it work of its own", () => {
    expect(isGroupingParent({ ...untouched, status: "todo" }, 2)).toBe(false);
    expect(isGroupingParent({ ...untouched, dispatch_attempts: 1 }, 2)).toBe(false);
    expect(isGroupingParent({ ...untouched, in_progress_at: "2026-11-01T00:00:00Z" }, 2)).toBe(false);
    expect(isGroupingParent({ ...untouched, delivered_by: "agent:claude" }, 2)).toBe(false);
    expect(isGroupingParent({ ...untouched, dispatch_state: "failed" }, 2)).toBe(false);
  });

  test("the rake's own question does not make a grouping parent work of its own", () => {
    expect(isGroupingParent({ ...untouched, ...askedByRake }, 2)).toBe(true);
    expect(isGroupingParent({ ...untouched, ...askedByRake, dispatch_state: "needs_input" }, 2)).toBe(true);
    // The same chip or delivery with another origin IS a trace of a turn.
    expect(isGroupingParent({ ...untouched, dispatch_state: "needs_input" }, 2)).toBe(false);
    expect(isGroupingParent({ ...untouched, delivered_by: "system", delivered_reason: "retries_exhausted" }, 2)).toBe(false);
    expect(isGroupingParent({ ...untouched, ...askedByRake, dispatch_state: "failed" }, 2)).toBe(false);
    expect(isGroupingParent({ ...untouched, ...askedByRake, dispatch_attempts: 1 }, 2)).toBe(false);
  });

  test("agrees with PARKED_CHILDREN_CANDIDATES_SQL on the same DB", () => {
    const db = freshDb();
    const now = "2026-11-08T12:00:00.000Z";
    const parents: Array<{ id: string } & Required<GroupingParentFields>> = [
      { id: "box", ...untouched },
      { id: "tried", ...untouched, dispatch_attempts: 2 },
      { id: "started", ...untouched, in_progress_at: now },
      { id: "delivered", ...untouched, delivered_by: "agent:claude" },
      { id: "failed", ...untouched, dispatch_state: "failed" },
      { id: "asked", ...untouched, ...askedByRake },
      { id: "asking", ...untouched, ...askedByRake, dispatch_state: "needs_input" },
      { id: "chip-alone", ...untouched, dispatch_state: "needs_input" },
      { id: "other-reason", ...untouched, delivered_by: "system", delivered_reason: "retries_exhausted" },
      { id: "asked-then-tried", ...untouched, ...askedByRake, dispatch_attempts: 1 },
    ];
    const insert = db.query(`INSERT INTO tasks (id, project_id, text, status, created_at, updated_at,
        dispatch_attempts, in_progress_at, delivered_by, delivered_reason, dispatch_state, parent_task_id)
      VALUES (?, 'p1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const p of parents) {
      insert.run(p.id, p.id, p.status, now, now, p.dispatch_attempts, p.in_progress_at, p.delivered_by, p.delivered_reason, p.dispatch_state, null);
      insert.run(`${p.id}-kid`, "kid", "todo", now, now, 0, null, null, null, null, p.id);
    }
    const candidates = new Set((db.query(PARKED_CHILDREN_CANDIDATES_SQL).all(now) as { id: string }[]).map((r) => r.id));
    for (const p of parents) {
      // A candidate of the parked sweep is exactly a parent that does NOT group.
      expect({ id: p.id, grouping: isGroupingParent(p, 1) }).toEqual({ id: p.id, grouping: !candidates.has(p.id) });
    }
    expect(candidates.has("box")).toBe(false);
    expect(candidates.has("asked")).toBe(false);
    expect(candidates.has("delivered")).toBe(true);
  });
});
