/**
 * @covers KANBAN-105
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { freshDb } from "../routes/tasks-test-support";
import { PLAN_HIERARCHY_DDL } from "../db/test-schema";
import { buildPlan, cardSignals, countCards, createArea, createMilestone, linkTask, deleteArea, addSource, PlanError } from "./plan";

let db: Database;
const T0 = Date.parse("2026-11-07T12:00:00Z");
const iso = (daysAgo: number) => new Date(T0 - daysAgo * 86_400_000).toISOString();

function task(id: string, o: Partial<Record<string, unknown>> = {}) {
  const r = { project_id: "p1", text: `card ${id}`, status: "todo", created_at: iso(1), updated_at: iso(1), ...o };
  db.query(`INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, assigned_topic_id, delivery_branch, delivery_commit)
            VALUES (?,?,?,?,?,?,?,?,?)`).run(id, r.project_id, r.text, r.status, r.created_at, r.updated_at,
    (r as any).assigned_topic_id ?? null, (r as any).delivery_branch ?? null, (r as any).delivery_commit ?? null);
}

beforeEach(() => {
  db = freshDb();
  db.run(PLAN_HIERARCHY_DDL);
});

describe("plan tree", () => {
  test("counts and progress at every level, unlinked cards go to «unplaced»", () => {
    const a = createArea(db, { projectId: "p1", name: "Auth" }) as any;
    const m = createMilestone(db, { areaId: a.id, title: "Login" }) as any;
    task("t1", { status: "done" }); task("t2", { status: "in_progress" }); task("t3");
    linkTask(db, "t1", m.id); linkTask(db, "t2", m.id);
    const p = buildPlan(db, { includeDone: true, now: T0 }).projects[0]!;
    expect(p.areas[0]!.milestones[0]!.progress).toMatchObject({ total: 2, done: 1, ratio: 0.5 });
    expect(p.areas[0]!.progress.total).toBe(2);
    expect(p.unplaced.tasks.map((c) => c.id)).toEqual(["t3"]);
    expect(p.progress).toMatchObject({ total: 3, done: 1 });
  });

  test("sub-cards follow their mother's milestone and show under her, grandchildren under the root", () => {
    const a = createArea(db, { projectId: "p1", name: "Auth" }) as any;
    const m = createMilestone(db, { areaId: a.id, title: "Login" }) as any;
    task("mom"); task("kid"); task("grandkid"); task("orphan"); task("gone");
    db.query(`UPDATE tasks SET parent_task_id = ? WHERE id = ?`).run("mom", "kid");
    db.query(`UPDATE tasks SET parent_task_id = ? WHERE id = ?`).run("kid", "grandkid");
    db.query(`UPDATE tasks SET parent_task_id = ? WHERE id = ?`).run("gone", "orphan");
    db.query(`UPDATE tasks SET archived = 1 WHERE id = 'gone'`).run();
    linkTask(db, "mom", m.id);
    const p = buildPlan(db, { now: T0 }).projects[0]!;
    const ms = p.areas[0]!.milestones[0]!;
    expect(ms.tasks.map((c) => c.id)).toEqual(["mom"]);
    expect(ms.tasks[0]!.children!.map((c) => c.id)).toEqual(["kid", "grandkid"]);
    expect(ms.progress.total).toBe(3);
    // A mother that is not there (archived, another board) does not hide the child.
    expect(p.unplaced.tasks.map((c) => c.id)).toEqual(["orphan"]);
  });

  test("projects with nothing open stay out, the rest goes by open work", () => {
    task("a1", { project_id: "zeta" }); task("a2", { project_id: "zeta" });
    task("b1", { project_id: "alfa" });
    task("c1", { project_id: "chiuso", status: "done" });
    const ids = buildPlan(db, { now: T0 }).projects.map((p) => p.projectId);
    expect(ids).toEqual(["zeta", "alfa"]);
    expect(buildPlan(db, { includeDone: true, now: T0 }).projects.map((p) => p.projectId)).toContain("chiuso");
  });

  test("a project with a plan comes before a bigger one without, and counts its open cards only", () => {
    for (const i of [1, 2, 3]) task(`big${i}`, { project_id: "big" });
    task("s1", { project_id: "small" }); task("s2", { project_id: "small", status: "done" });
    createArea(db, { projectId: "small", name: "A" });
    const projects = buildPlan(db, { now: T0 }).projects;
    expect(projects.map((p) => p.projectId)).toEqual(["small", "big"]);
    expect(projects.map((p) => p.openCount)).toEqual([1, 3]);
  });

  test("the project carries its folder, from the board slug too, for its real icon", () => {
    db.run(`CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT, path TEXT)`);
    db.query(`INSERT INTO projects (id, name, path) VALUES ('px', 'quadra', '/Users/me/Projects/quadra')`).run();
    task("q1", { project_id: "px" }); task("v1", { project_id: "virtual" });
    const byId = new Map(buildPlan(db, { now: T0 }).projects.map((p) => [p.projectId, p.path]));
    expect(byId.get("px")).toBe("/Users/me/Projects/quadra");
    expect(byId.get("virtual")).toBeNull();
  });

  test("two boards with the same project name are told apart by their id", () => {
    db.run(`CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT, path TEXT)`);
    db.query(`INSERT INTO projects (id, name, path) VALUES ('x1', 'attilio', NULL)`).run();
    db.query(`INSERT INTO projects (id, name, path) VALUES ('x2', 'attilio', NULL)`).run();
    task("a1", { project_id: "x1" }); task("b1", { project_id: "x2" });
    const names = buildPlan(db, { now: T0 }).projects.map((p) => p.name).sort();
    expect(names).toEqual(["attilio (x1)", "attilio (x2)"]);
  });

  test("done cards are hidden from lists by default but still count", () => {
    const a = createArea(db, { projectId: "p1", name: "A" }) as any;
    const m = createMilestone(db, { areaId: a.id, title: "M" }) as any;
    task("t1", { status: "done" }); linkTask(db, "t1", m.id);
    const ms = buildPlan(db, { now: T0 }).projects[0]!.areas[0]!.milestones[0]!;
    expect(ms.tasks).toHaveLength(0);
    expect(ms.progress.done).toBe(1);
  });

  test("a card is in one milestone only: re-linking moves it", () => {
    const a = createArea(db, { projectId: "p1", name: "A" }) as any;
    const m1 = createMilestone(db, { areaId: a.id, title: "M1" }) as any;
    const m2 = createMilestone(db, { areaId: a.id, title: "M2" }) as any;
    task("t1");
    linkTask(db, "t1", m1.id); linkTask(db, "t1", m2.id);
    expect(db.query(`SELECT COUNT(*) AS n FROM plan_task_links WHERE task_id='t1'`).get()).toEqual({ n: 1 });
    expect((db.query(`SELECT milestone_id FROM plan_task_links WHERE task_id='t1'`).get() as any).milestone_id).toBe(m2.id);
  });

  test("una card in una sola milestone: the schema itself rejects a second link", () => {
    const a = createArea(db, { projectId: "p1", name: "A" }) as any;
    const m1 = createMilestone(db, { areaId: a.id, title: "M1" }) as any;
    const m2 = createMilestone(db, { areaId: a.id, title: "M2" }) as any;
    task("t1");
    const insertLink = db.query(`INSERT INTO plan_task_links (task_id, milestone_id, created_at) VALUES ('t1', ?, 'x')`);
    insertLink.run(m1.id);
    expect(() => insertLink.run(m2.id)).toThrow();
  });

  test("a milestone of another project is refused", () => {
    const a = createArea(db, { projectId: "p2", name: "A" }) as any;
    const m = createMilestone(db, { areaId: a.id, title: "M" }) as any;
    task("t1");
    expect(() => linkTask(db, "t1", m.id)).toThrow(PlanError);
  });

  test("deleting an area unlinks cards, never deletes them", () => {
    const a = createArea(db, { projectId: "p1", name: "A" }) as any;
    const m = createMilestone(db, { areaId: a.id, title: "M" }) as any;
    task("t1"); linkTask(db, "t1", m.id);
    deleteArea(db, a.id);
    expect(db.query(`SELECT COUNT(*) AS n FROM tasks`).get()).toEqual({ n: 1 });
    expect(db.query(`SELECT COUNT(*) AS n FROM plan_task_links`).get()).toEqual({ n: 0 });
    expect(buildPlan(db, { now: T0 }).projects[0]!.unplaced.tasks).toHaveLength(1);
  });
});

describe("signals", () => {
  const base = { status: "todo", assigned_topic_id: "x", delivery_branch: null, delivery_commit: null, updated_at: iso(1) };
  test("delivered but open: branch or commit with status != done", () => {
    expect(cardSignals({ ...base, delivery_branch: "b" }, null, T0)).toContain("delivered_but_open");
    expect(cardSignals({ ...base, delivery_commit: "c" }, null, T0)).toContain("delivered_but_open");
    expect(cardSignals({ ...base, delivery_commit: "c", status: "done" }, null, T0)).not.toContain("delivered_but_open");
  });
  test("no owner needs no topic AND no milestone owner", () => {
    expect(cardSignals({ ...base, assigned_topic_id: null }, null, T0)).toContain("no_owner");
    expect(cardSignals({ ...base, assigned_topic_id: null }, "Anna", T0)).not.toContain("no_owner");
  });
  test("stale after 7 days, not at 6", () => {
    expect(cardSignals({ ...base, updated_at: iso(8) }, null, T0)).toContain("stale");
    expect(cardSignals({ ...base, updated_at: iso(6) }, null, T0)).not.toContain("stale");
  });
  test("duplicates flagged on the non-survivor, with its survivor", () => {
    task("a", { text: "Fix the login redirect loop on expired sessions", created_at: iso(3) });
    task("b", { text: "Fix the login redirect loop on expired sessions", created_at: iso(2) });
    const cards = buildPlan(db, { now: T0 }).projects[0]!.unplaced.tasks;
    const b = cards.find((c) => c.id === "b")!;
    expect(b.signals).toContain("duplicate");
    expect(b.duplicateOf).toBe("a");
    expect(cards.find((c) => c.id === "a")!.signals).not.toContain("duplicate");
  });
});

describe("sources", () => {
  test("implicit sources come from the card, explicit ones from plan_sources", () => {
    task("t1", { assigned_topic_id: null, delivery_branch: "feat/x" });
    addSource(db, { taskId: "t1", kind: "pr", label: "PR 12", url: "https://x/12" });
    const c = buildPlan(db, { now: T0 }).projects[0]!.unplaced.tasks[0]!;
    expect(c.sources.map((s) => [s.kind, s.implicit])).toEqual([["branch", true], ["pr", false]]);
  });
  test("a source needs exactly one owner", () => {
    task("t1");
    expect(() => addSource(db, { kind: "pr", label: "x" })).toThrow(PlanError);
  });
});

test("countCards", () => {
  expect(countCards([{ status: "done" }, { status: "todo" }, { status: "todo" }])).toEqual({ total: 3, done: 1, byStatus: { done: 1, todo: 2 } });
});
