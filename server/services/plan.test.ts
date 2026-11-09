/**
 * @covers KANBAN-105
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { freshDb } from "../routes/tasks-test-support";
import { PLAN_HIERARCHY_DDL } from "../db/test-schema";
import { UNKNOWN_PROJECT_NAME } from "../../shared/project-name";
import { activityOf, buildPlan, cardSignals, countCards, createArea, createMilestone, linkTask, deleteArea, addSource, PlanError } from "./plan";

let db: Database;
const T0 = Date.parse("2026-11-07T12:00:00Z");
const iso = (daysAgo: number) => new Date(T0 - daysAgo * 86_400_000).toISOString();

function task(id: string, o: Partial<Record<string, unknown>> = {}) {
  const r = { project_id: "p1", text: `card ${id}`, status: "todo", created_at: iso(1), updated_at: iso(1), ...o };
  db.query(`INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, assigned_topic_id, delivery_branch, delivery_commit)
            VALUES (?,?,?,?,?,?,?,?,?)`).run(id, r.project_id, r.text, r.status, r.created_at, r.updated_at,
    (r as any).assigned_topic_id ?? null, (r as any).delivery_branch ?? null, (r as any).delivery_commit ?? null);
}
/** Sets extra columns on a card (dispatch_state, parent_task_id, stage…). */
function set(id: string, cols: Record<string, unknown>) {
  const keys = Object.keys(cols);
  db.query(`UPDATE tasks SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...(keys.map((k) => cols[k]) as any[]), id);
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

  test("projects with nothing open stay out, the rest goes by name with the one waiting for the person first", () => {
    task("a1", { project_id: "zeta" }); task("a2", { project_id: "zeta" });
    task("b1", { project_id: "alfa" });
    task("c1", { project_id: "chiuso", status: "done" });
    expect(buildPlan(db, { now: T0 }).projects.map((p) => p.projectId)).toEqual(["alfa", "zeta"]);
    // «waiter» sorts after both by name: it is first only because a card of it is in review.
    task("w1", { project_id: "waiter", status: "review" });
    expect(buildPlan(db, { now: T0 }).projects.map((p) => p.projectId)).toEqual(["waiter", "alfa", "zeta"]);
    expect(buildPlan(db, { includeDone: true, now: T0 }).projects.map((p) => p.projectId)).toContain("chiuso");
  });

  test("a project with a plan is listed like the others, by name and after the ones waiting for the person, and counts its open cards only", () => {
    for (const i of [1, 2, 3]) task(`big${i}`, { project_id: "big" });
    task("s1", { project_id: "small" }); task("s2", { project_id: "small", status: "done" });
    createArea(db, { projectId: "small", name: "A" });
    const projects = buildPlan(db, { now: T0 }).projects;
    // Not by size and not by having a plan: the Kanban lanes keep the same order.
    expect(projects.map((p) => p.projectId)).toEqual(["big", "small"]);
    expect(projects.map((p) => p.openCount)).toEqual([3, 1]);
    task("z1", { project_id: "zz", status: "review" });
    expect(buildPlan(db, { now: T0 }).projects.map((p) => p.projectId)).toEqual(["zz", "big", "small"]);
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
  const base = { status: "todo" as const, assigned_topic_id: "x", delivery_commit: null as string | null, landing_state: null as string | null, updated_at: iso(1) };
  test("delivered, then reopened: a commit or a landing, outside review and not done", () => {
    expect(cardSignals({ ...base, delivery_commit: "c" }, null, T0)).toContain("delivered_but_open");
    expect(cardSignals({ ...base, status: "backlog", landing_state: "landed" }, null, T0)).toContain("delivered_but_open");
    expect(cardSignals({ ...base, delivery_commit: "c", status: "done" }, null, T0)).not.toContain("delivered_but_open");
    // In review the delivery IS the approval, already in «waiting for you».
    expect(cardSignals({ ...base, delivery_commit: "c", status: "review" }, null, T0)).not.toContain("delivered_but_open");
  });
  test("a card in todo with a delivery commit reads «Consegnata, poi riaperta»", () => {
    task("re", { delivery_commit: "abc123" });
    const c = buildPlan(db, { now: T0 }).projects[0]!.unplaced.tasks[0]!;
    expect(c.signals).toContain("delivered_but_open");
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

describe("what waits for the person, and the header state", () => {
  const comment = (taskId: string, content: string, author = "agent:claude") =>
    db.query(`INSERT INTO task_comments (id, task_id, author, content, created_at) VALUES (?,?,?,?,?)`)
      .run(crypto.randomUUID(), taskId, author, content, iso(0));

  test("needsYou: review, open question, «aspetta: attilio», human_ask; nothing for done or ai_review", () => {
    task("rev", { status: "review" });
    task("ai", { status: "review" }); db.query(`UPDATE tasks SET stage = 'ai_review' WHERE id = 'ai'`).run();
    task("ask", { status: "in_progress" }); comment("ask", "Prima di andare avanti:\n```question\nUso Postgres o SQLite?\n- Postgres\n- SQLite\n```");
    task("answered"); comment("answered", "```question\nVa bene?\n- sì\n```"); comment("answered", "sì", "user");
    task("waits", { status: "backlog" }); db.query(`UPDATE tasks SET description = ? WHERE id = 'waits'`).run("Piano.\naspetta: attilio — l'elenco è completo?");
    task("human", { status: "review" }); db.query(`UPDATE tasks SET stage = 'human_review', human_ask = 'Ti piace il colore?' WHERE id = 'human'`).run();
    task("closed", { status: "done" }); db.query(`UPDATE tasks SET description = 'aspetta: attilio' WHERE id = 'closed'`).run();
    comment("closed", "```question\nE questa?\n```");
    const p = buildPlan(db, { now: T0 }).projects[0]!;
    const by = Object.fromEntries(p.needsYou.map((n) => [n.taskId, n]));
    expect(Object.keys(by).sort()).toEqual(["ask", "human", "rev", "waits"]);
    expect(by.rev!.reason).toBe("review");
    expect(by.ask).toMatchObject({ reason: "question", detail: "Uso Postgres o SQLite?" });
    expect(by.waits).toMatchObject({ reason: "waits", detail: "l'elenco è completo?" });
    expect(by.human).toMatchObject({ reason: "human_ask", detail: "Ti piace il colore?" });
  });

  test("activity: working as soon as one card is in progress, else the prevailing state", () => {
    const a = createArea(db, { projectId: "p1", name: "A" }) as any;
    const m1 = createMilestone(db, { areaId: a.id, title: "M1" }) as any;
    const m2 = createMilestone(db, { areaId: a.id, title: "M2" }) as any;
    task("w1", { status: "in_progress" }); task("w2", { status: "in_progress" }); task("t1");
    set("w1", { dispatch_state: "working" }); set("w2", { dispatch_state: "starting" });
    task("r1", { status: "review" }); task("old", { updated_at: iso(30) });
    linkTask(db, "w1", m1.id); linkTask(db, "t1", m1.id); linkTask(db, "r1", m2.id);
    task("q1", { project_id: "p2", updated_at: iso(30) });
    const plan = buildPlan(db, { now: T0 });
    const p1 = plan.projects.find((p) => p.projectId === "p1")!;
    expect(p1.activity).toEqual({ state: "working", count: 2 });
    expect(p1.areas[0]!.milestones[0]!.activity).toEqual({ state: "working", count: 1 });
    expect(p1.areas[0]!.milestones[1]!.activity).toEqual({ state: "review", count: 1 });
    expect(plan.projects.find((p) => p.projectId === "p2")!.activity).toEqual({ state: "stale", count: 1 });
  });

  test("order: waiting for the person first, then by name; being at work does not lift a project", () => {
    task("a", { project_id: "idle" }); task("b", { project_id: "idle" }); task("c", { project_id: "idle" });
    task("d", { project_id: "busy", status: "in_progress" }); set("d", { dispatch_state: "working" });
    task("e", { project_id: "needs", status: "review" });
    task("f", { project_id: "zwait", status: "review" });
    const projects = buildPlan(db, { now: T0 }).projects;
    expect(projects.map((p) => p.projectId)).toEqual(["needs", "zwait", "busy", "idle"]);
    expect(projects.map((p) => [p.projectId, p.needsYou.length > 0, p.activity.state === "working"]))
      .toEqual([["needs", true, false], ["zwait", true, false], ["busy", false, true], ["idle", false, false]]);
  });

  test("a project nobody registered is named from its id: the folder of a path, the slug without its hash, a sentence for a code", () => {
    task("t1", { project_id: "/Users/x/.openclaw/workspace/topics-app" });
    task("t2", { project_id: "quadra-lh40qh" });
    task("t3", { project_id: "405fbb0d-6fdd-4874-b52d-ce96180f9e2a" });
    const names = new Map(buildPlan(db, { now: T0 }).projects.map((p) => [p.projectId, p.name]));
    expect(names.get("/Users/x/.openclaw/workspace/topics-app")).toBe("topics-app");
    expect(names.get("quadra-lh40qh")).toBe("quadra");
    expect(names.get("405fbb0d-6fdd-4874-b52d-ce96180f9e2a")).toBe(UNKNOWN_PROJECT_NAME);
  });
});

describe("counts and states with the Kanban's rules", () => {
  test("ai_review does not count as «to approve»: it is the reviewer agent at work", () => {
    const card = (status: any, stage: string | null = null) => ({ status, stage, dispatchState: null, signals: [] });
    expect(activityOf([card("review", "ai_review")])).toEqual({ state: "working", count: 1 });
    expect(activityOf([card("review", "human_review"), card("review", "ai_review")])).toEqual({ state: "working", count: 1 });
    expect(activityOf([card("review", "human_review"), card("todo")])).toEqual({ state: "review", count: 1 });
  });

  test("in_progress without an agent is not at work", () => {
    task("idle", { status: "in_progress" });
    const p = buildPlan(db, { now: T0 }).projects[0]!;
    expect(p.activity.state).not.toBe("working");
    set("idle", { dispatch_state: "working" });
    expect(buildPlan(db, { now: T0 }).projects[0]!.activity).toEqual({ state: "working", count: 1 });
  });

  test("a grouping parent with 2+ children counts as a board card but stays out of activity and «no owner»", () => {
    task("box", { status: "backlog" }); task("k1"); task("k2"); task("solo");
    set("k1", { parent_task_id: "box" }); set("k2", { parent_task_id: "box" });
    const p = buildPlan(db, { now: T0 }).projects[0]!;
    // Same number as the Kanban: «box» and «solo» are board cards, k1/k2 sit inside «box».
    expect(p.openCount).toBe(2);
    expect(p.openSubCount).toBe(2);
    expect(p.activity).toEqual({ state: "todo", count: 3 });
    const box = p.unplaced.tasks.find((c) => c.id === "box")!;
    expect(box.grouping).toBe(true);
    expect(box.signals).not.toContain("no_owner");
    expect(box.children!.map((c) => c.id)).toEqual(["k1", "k2"]);
    // A parent a turn touched is work of its own: it joins the activity.
    set("box", { dispatch_attempts: 1 });
    expect(buildPlan(db, { now: T0 }).projects[0]!.activity.count).toBe(4);
    // A sub-card whose mother is closed is a board card again, as on the Kanban.
    set("box", { status: "done" });
    const q = buildPlan(db, { now: T0 }).projects[0]!;
    expect(q.openCount).toBe(3);
    expect(q.openSubCount).toBe(0);
  });

  test("a sub-card in milestone M brings its unlinked mother into M, with the sub-card under her", () => {
    const a = createArea(db, { projectId: "p1", name: "A" }) as any;
    const m = createMilestone(db, { areaId: a.id, title: "M" }) as any;
    const other = createMilestone(db, { areaId: a.id, title: "Other" }) as any;
    task("mom", { status: "backlog" }); task("k1"); task("k2"); task("k3");
    for (const k of ["k1", "k2", "k3"]) set(k, { parent_task_id: "mom" });
    linkTask(db, "k1", m.id); linkTask(db, "k2", m.id); linkTask(db, "k3", other.id);
    const p = buildPlan(db, { now: T0 }).projects[0]!;
    const [ms, ot] = p.areas[0]!.milestones;
    expect(p.unplaced.tasks).toHaveLength(0);
    expect(ms!.tasks.map((c) => c.id)).toEqual(["mom"]);
    // The one linked elsewhere still shows under her, and still counts where it is linked.
    expect(ms!.tasks[0]!.children!.map((c) => c.id)).toEqual(["k1", "k2", "k3"]);
    expect(ot!.tasks).toHaveLength(0);
    expect(ot!.progress.total).toBe(1);
  });

  test("a parked backlog card waits for the person", () => {
    task("stuck", { status: "backlog" }); set("stuck", { dispatch_state: "failed", dispatch_error: "CLI exited 1" });
    const p = buildPlan(db, { now: T0 }).projects[0]!;
    expect(p.needsYou).toEqual([{ taskId: "stuck", text: "card stuck", reason: "parked", detail: "CLI exited 1" }]);
  });
});
