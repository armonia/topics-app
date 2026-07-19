import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createTaskService, projectIdForPath, TaskServiceError, type TaskService } from "./tasks";

// Minimal DDL — the subset of migration 001 + 026 the service touches. Kept in
// sync with server/db/migrations/*.sql by intent; if the service starts using a
// new column, add it here too. PRAGMA foreign_keys + the assigned_topic_id FK
// are deliberately faithful to prod: the "pending:<taskId>" placeholder bug
// only reproduced with the FK enforced.
function freshDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  db.run(`CREATE TABLE topics (id TEXT PRIMARY KEY)`);
  db.run(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, text TEXT NOT NULL, description TEXT,
    status TEXT NOT NULL DEFAULT 'todo', priority INTEGER NOT NULL DEFAULT 2,
    kanban_order INTEGER NOT NULL DEFAULT 0, assigned_to TEXT, fingerprint TEXT, due_date TEXT,
    chat_id TEXT, created_at TEXT NOT NULL, completed_at TEXT, updated_at TEXT NOT NULL,
    claude_task_id TEXT, assigned_topic_id TEXT REFERENCES topics(id), archived INTEGER NOT NULL DEFAULT 0,
    assigned_agent_id TEXT, in_progress_at TEXT,
    dispatch_attempts INTEGER NOT NULL DEFAULT 0, dispatch_state TEXT, dispatch_error TEXT,
    parent_task_id TEXT REFERENCES tasks(id), output_url TEXT, plan_first INTEGER NOT NULL DEFAULT 0,
    agent_ms INTEGER NOT NULL DEFAULT 0, agent_tokens INTEGER NOT NULL DEFAULT 0,
    agent_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    model TEXT, blocked_by_task_id TEXT REFERENCES tasks(id), reuse_blocker_context INTEGER NOT NULL DEFAULT 0,
    priority_auto INTEGER NOT NULL DEFAULT 1
  )`);
  db.run(`CREATE UNIQUE INDEX idx_tasks_claude_task_id ON tasks(claude_task_id) WHERE claude_task_id IS NOT NULL`);
  db.run(`CREATE TABLE board_settings (
    project_id TEXT PRIMARY KEY, require_approval_for_done INTEGER DEFAULT 0,
    require_review_before_done INTEGER DEFAULT 0, block_status_with_pending INTEGER DEFAULT 0,
    only_lead_can_change_status INTEGER DEFAULT 0, max_agents INTEGER DEFAULT 5, auto_expire_hours INTEGER DEFAULT 24,
    auto_dispatch INTEGER NOT NULL DEFAULT 0, dispatch_effort TEXT NOT NULL DEFAULT 'medium',
    dispatch_use_worktree INTEGER NOT NULL DEFAULT 1, dispatch_timeout_min INTEGER NOT NULL DEFAULT 20,
    dispatch_mcp TEXT,
    dispatch_retry_cap INTEGER, dispatch_retry_backoff_s INTEGER
  )`);
  db.run(`CREATE TABLE task_comments (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author TEXT NOT NULL DEFAULT 'user',
    content TEXT NOT NULL, mentions TEXT, media TEXT, created_at TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'comment'
  )`);
  db.run(`CREATE TABLE approvals (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, requested_by TEXT NOT NULL,
    approval_type TEXT NOT NULL, from_status TEXT, to_status TEXT, confidence_score REAL,
    rubric_scores TEXT, justification TEXT, status TEXT NOT NULL DEFAULT 'pending',
    reviewed_by TEXT, review_comment TEXT, created_at TEXT NOT NULL, reviewed_at TEXT, expires_at TEXT
  )`);
  return db;
}

// Controllable clock + counter uuid → deterministic rows.
function svc(db: Database, clock = { t: Date.parse("2026-07-09T10:00:00.000Z") }): TaskService {
  let n = 0;
  return createTaskService(db, {
    now: () => new Date(clock.t).toISOString(),
    uuid: () => `id-${++n}`,
  });
}

const PID = "topics-app-abc123";

describe("projectIdForPath", () => {
  test("basename + 6-char base36 hash, deterministic", () => {
    const a = projectIdForPath("/Users/zorahrel/Projects/topics-app");
    const b = projectIdForPath("/Users/zorahrel/Projects/topics-app");
    expect(a).toBe(b);
    expect(a.startsWith("topics-app-")).toBe(true);
    expect(a.slice("topics-app-".length)).toMatch(/^[0-9a-z]{1,6}$/);
  });
  // Exact-value lock: pins the format byte-for-byte so any drift from the
  // canonical algorithm in routes/topics.ts:getProjectIdForTopic breaks here.
  // (The raw path is hashed, so a trailing slash DOES change the id — matches
  // the original; topic.projectPath is stored normalized, so it never bites.)
  test("exact output is stable (regression lock)", () => {
    expect(projectIdForPath("/x/proj")).toBe("proj-xwac8t");
  });
});

describe("create", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  test("creates a todo with incrementing kanban_order", () => {
    const t1 = s.create({ projectId: PID, text: "one" });
    const t2 = s.create({ projectId: PID, text: "two" });
    expect(t1.status).toBe("todo");
    expect(t1.kanbanOrder).toBe(1);
    expect(t2.kanbanOrder).toBe(2);
  });

  test("idempotencyKey returns the same task, no duplicate", () => {
    const a = s.create({ projectId: PID, text: "x", idempotencyKey: "K1" });
    const b = s.create({ projectId: PID, text: "x again", idempotencyKey: "K1" });
    expect(b.id).toBe(a.id);
    expect((db.prepare("SELECT COUNT(*) c FROM tasks").get() as any).c).toBe(1);
  });

  test("planFirst persists through create → get (default false)", () => {
    const t = s.create({ projectId: PID, text: "big thing", planFirst: true });
    expect(t.planFirst).toBe(true);
    expect(s.get(t.id)!.task.planFirst).toBe(true);
    expect(s.create({ projectId: PID, text: "normal" }).planFirst).toBe(false);
  });

  test("planFirst is togglable via update (settable after creation)", () => {
    const t = s.create({ projectId: PID, text: "fuzzy bug" });
    expect(t.planFirst).toBe(false);
    expect(s.update({ taskId: t.id, actor: "human", by: "u", patch: { planFirst: true } }).planFirst).toBe(true);
    expect(s.update({ taskId: t.id, actor: "human", by: "u", patch: { planFirst: false } }).planFirst).toBe(false);
  });

  test("rejects empty text and create-done", () => {
    expect(() => s.create({ projectId: PID, text: "  " })).toThrow(TaskServiceError);
    expect(() => s.create({ projectId: PID, text: "y", status: "done" })).toThrow(/done/);
  });
});

describe("list", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => {
    db = freshDb(); s = svc(db);
    s.create({ projectId: "p1", text: "a" });
    s.create({ projectId: "p1", text: "b" });
    s.create({ projectId: "p2", text: "c" });
  });

  test("scope=project filters by project", () => {
    expect(s.list({ scope: "project", projectId: "p1" }).length).toBe(2);
    expect(s.list({ scope: "project", projectId: "p2" }).length).toBe(1);
  });
  test("scope=all crosses projects", () => {
    const all = s.list({ scope: "all" });
    expect(all.length).toBe(3);
    expect(new Set(all.map(t => t.projectId))).toEqual(new Set(["p1", "p2"]));
  });
  test("scope=project without projectId throws", () => {
    expect(() => s.list({ scope: "project" })).toThrow(/projectId/);
  });

  test("rootsOnly hides subtasks from column feeds (they live in the parent's tree)", () => {
    const parent = s.create({ projectId: "p1", text: "epic" });
    s.create({ projectId: "p1", text: "step 1", parentTaskId: parent.id });
    s.create({ projectId: "p1", text: "step 2", parentTaskId: parent.id });
    // Default list still returns everything (agent surface, introspection).
    expect(s.list({ scope: "project", projectId: "p1" }).length).toBe(5);
    // Board feed: roots only, on both scopes.
    const roots = s.list({ scope: "project", projectId: "p1", rootsOnly: true });
    expect(roots.length).toBe(3);
    expect(roots.every((t) => t.parentTaskId === null)).toBe(true);
    expect(s.list({ scope: "all", rootsOnly: true }).every((t) => t.parentTaskId === null)).toBe(true);
    // The steps are still reachable through the parent.
    expect(s.get(parent.id)!.children.length).toBe(2);
  });
});

describe("review gate (KANBAN-05)", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  test("agent cannot move to done", () => {
    const t = s.create({ projectId: PID, text: "work" });
    expect(() => s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "done" } }))
      .toThrow(/only a human/);
  });

  test("agent → review opens a pending review approval", () => {
    const t = s.create({ projectId: PID, text: "work" });
    s.addComment({ taskId: t.id, author: "claude", content: "fatto: sintesi di consegna" });
    const r = s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });
    expect(r.status).toBe("review");
    const ap = db.prepare("SELECT * FROM approvals WHERE task_id = ?").get(t.id) as any;
    expect(ap.approval_type).toBe("review");
    expect(ap.status).toBe("pending");
    expect(ap.requested_by).toBe("claude");
  });

  test("mute delivery is rejected: agent → review requires an own comment", () => {
    const t = s.create({ projectId: PID, text: "work" });
    // No comments at all → coached rejection, task stays put.
    expect(() => s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } }))
      .toThrow(/summary/);
    // A human/system note does NOT count — the card must carry the AGENT's word.
    s.addComment({ taskId: t.id, author: "user", content: "occhio ai test" });
    s.addComment({ taskId: t.id, author: "system", content: "requeued" });
    expect(() => s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } }))
      .toThrow(/summary/);
    // The agent's own summary unlocks the handoff. Humans stay unaffected.
    s.addComment({ taskId: t.id, author: "claude", content: "fatto, guarda demo/" });
    expect(s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } }).status).toBe("review");
  });

  test("human re-drag to todo resets the retry budget (parked tasks stay re-dispatchable)", () => {
    const t = s.create({ projectId: PID, text: "work", status: "backlog" });
    db.prepare("UPDATE tasks SET dispatch_attempts = 3 WHERE id = ?").run(t.id);
    const back = s.update({ taskId: t.id, actor: "human", by: "user", patch: { status: "todo" } });
    expect(back.dispatchAttempts).toBe(0);
    // An AGENT moving to todo does NOT refresh its own retries.
    db.prepare("UPDATE tasks SET dispatch_attempts = 3, status = 'backlog' WHERE id = ?").run(t.id);
    const agentMove = s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "todo" } });
    expect(agentMove.dispatchAttempts).toBe(3);
  });

  test("human drag review → done clears the lingering dispatch chip", () => {
    const t = s.create({ projectId: PID, text: "work" });
    s.update({ taskId: t.id, actor: "human", by: "user", patch: { status: "review" } });
    s.setDispatchState({ taskId: t.id, state: "delivered" });
    const done = s.update({ taskId: t.id, actor: "human", by: "user", patch: { status: "done" } });
    expect(done.status).toBe("done");
    expect(done.dispatchState).toBeNull();
  });

  test("status events (kind='status') do NOT satisfy the mute-delivery gate", () => {
    const t = s.create({ projectId: PID, text: "work" });
    // The agent moving the task writes a status event AUTHORED by the agent —
    // it's history, not a delivery summary.
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "in_progress" } });
    const evts = db.prepare("SELECT * FROM task_comments WHERE task_id = ? AND kind = 'status'").all(t.id) as any[];
    expect(evts.length).toBe(1);
    expect(evts[0].author).toBe("claude");
    expect(evts[0].content).toBe("todo→in_progress");
    expect(() => s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } }))
      .toThrow(/summary/);
  });

  test("mute-delivery gate is PER-TURN: a stale summary from an earlier turn does not unlock a new delivery", () => {
    // The reported bug: a steered task ("altro da fare?" → review) handed back a
    // mute delivery because an OLD agent comment satisfied the gate. The gate must
    // require a comment made during THIS turn (after the newest …→in_progress).
    const t = s.create({ projectId: PID, text: "work" });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "in_progress" } });
    s.addComment({ taskId: t.id, author: "claude", content: "riepilogo turno 1" });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } }); // ok: fresh
    // Age the turn-1 summary so it clearly predates the next turn (deterministic).
    db.prepare("UPDATE task_comments SET created_at = ? WHERE task_id = ? AND kind = 'comment'").run("2020-01-01T00:00:00.000Z", t.id);
    // Turn 2 starts: a NEW …→in_progress event, newer than the stale summary.
    s.update({ taskId: t.id, actor: "human", by: "user", patch: { status: "in_progress" } });
    // Mute re-delivery is rejected — the old summary no longer counts.
    expect(() => s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } }))
      .toThrow(/summary/);
    // A fresh summary for THIS turn unlocks it.
    s.addComment({ taskId: t.id, author: "claude", content: "riepilogo turno 2" });
    expect(s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } }).status).toBe("review");
  });

  test("status history: update, claim and reviewDecision log who moved it and when", () => {
    const t = s.create({ projectId: PID, text: "work", status: "backlog" });
    s.update({ taskId: t.id, actor: "human", by: "user", patch: { status: "todo" } });
    const claimed = s.claim({ taskId: t.id, cap: 2, maxAttempts: 3 });
    expect(claimed).not.toBeNull();
    s.addComment({ taskId: t.id, author: "agent-x", content: "consegna" });
    s.update({ taskId: t.id, actor: "agent", by: "agent-x", patch: { status: "review" } });
    s.reviewDecision({ taskId: t.id, by: "user", decision: "approve" });

    const events = (s.get(t.id)!.comments).filter((c) => c.kind === "status");
    expect(events.map((e) => [e.content, e.author])).toEqual([
      ["backlog→todo", "user"],
      ["todo→in_progress", "dispatcher"],
      ["in_progress→review", "agent-x"],
      ["review→done", "user"],
    ]);
    // Normal comments keep kind='comment'.
    const normal = (s.get(t.id)!.comments).find((c) => c.content === "consegna");
    expect(normal?.kind).toBe("comment");
  });

  test("human approve → done, approval approved, completed_at set", () => {
    const t = s.create({ projectId: PID, text: "work" });
    s.addComment({ taskId: t.id, author: "claude", content: "fatto" });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });
    const done = s.reviewDecision({ taskId: t.id, by: "attilio", decision: "approve" });
    expect(done.status).toBe("done");
    expect(done.completedAt).not.toBeNull();
    const ap = db.prepare("SELECT * FROM approvals WHERE task_id = ?").get(t.id) as any;
    expect(ap.status).toBe("approved");
    expect(ap.reviewed_by).toBe("attilio");
  });

  test("human reject → in_progress + comment + approval rejected", () => {
    const t = s.create({ projectId: PID, text: "work" });
    s.addComment({ taskId: t.id, author: "claude", content: "fatto" });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });
    const back = s.reviewDecision({ taskId: t.id, by: "attilio", decision: "reject", comment: "manca il test" });
    expect(back.status).toBe("in_progress");
    const got = s.get(t.id)!;
    expect(got.comments.some(c => c.content === "manca il test")).toBe(true);
    const ap = db.prepare("SELECT * FROM approvals WHERE task_id = ?").get(t.id) as any;
    expect(ap.status).toBe("rejected");
  });

  test("reject resets the attempt budget (new work cycle); approve keeps it", () => {
    const t = s.create({ projectId: PID, text: "work" });
    s.addComment({ taskId: t.id, author: "claude", content: "fatto" });
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });
    db.prepare("UPDATE tasks SET dispatch_attempts = 2 WHERE id = ?").run(t.id);
    const back = s.reviewDecision({ taskId: t.id, by: "attilio", decision: "reject" });
    expect(back.dispatchAttempts).toBe(0);

    const t2 = s.create({ projectId: PID, text: "work2" });
    s.addComment({ taskId: t2.id, author: "claude", content: "fatto" });
    s.update({ taskId: t2.id, actor: "agent", by: "claude", patch: { status: "review" } });
    db.prepare("UPDATE tasks SET dispatch_attempts = 2 WHERE id = ?").run(t2.id);
    const done = s.reviewDecision({ taskId: t2.id, by: "attilio", decision: "approve" });
    expect(done.dispatchAttempts).toBe(2);
  });

  test("projectId guard blocks cross-project get/update/comment", () => {
    const t = s.create({ projectId: "p1", text: "x" });
    expect(s.get(t.id, { projectId: "p2" })).toBeNull();
    expect(() => s.update({ taskId: t.id, actor: "agent", by: "c", projectId: "p2", patch: { status: "review" } }))
      .toThrow(/not found/);
    expect(() => s.addComment({ taskId: t.id, author: "c", content: "hi", projectId: "p2" }))
      .toThrow(/not found/);
    expect(s.get(t.id, { projectId: "p1" })).not.toBeNull();
  });

  test("human can move directly to done", () => {
    const t = s.create({ projectId: PID, text: "work", status: "in_progress" });
    const done = s.update({ taskId: t.id, actor: "human", by: "attilio", patch: { status: "done" } });
    expect(done.status).toBe("done");
    expect(done.completedAt).not.toBeNull();
  });
});

describe("own steps carve-out (KANBAN-08: the agent checks off its own checklist)", () => {
  let db: Database; let s: TaskService;
  // parent = the task dispatched to topic 'top-1'; steps nest under it.
  let parentId: string;
  beforeEach(() => {
    db = freshDb(); s = svc(db);
    db.run("INSERT INTO topics (id) VALUES ('top-1'), ('top-2')");
    const parent = s.create({ projectId: PID, text: "deliverable", status: "in_progress" });
    parentId = parent.id;
    db.prepare("UPDATE tasks SET assigned_topic_id = 'top-1' WHERE id = ?").run(parentId);
  });

  test("agent marks its own direct step done (completed_at set)", () => {
    const step = s.create({ projectId: PID, text: "step 1", status: "backlog", parentTaskId: parentId });
    const done = s.update({ taskId: step.id, actor: "agent", by: "claude", agentTopicId: "top-1", patch: { status: "done" } });
    expect(done.status).toBe("done");
    expect(done.completedAt).not.toBeNull();
  });

  test("carve-out reaches any depth (step of a step)", () => {
    const step = s.create({ projectId: PID, text: "step", status: "backlog", parentTaskId: parentId });
    const sub = s.create({ projectId: PID, text: "sub-step", status: "backlog", parentTaskId: step.id });
    const done = s.update({ taskId: sub.id, actor: "agent", by: "claude", agentTopicId: "top-1", patch: { status: "done" } });
    expect(done.status).toBe("done");
  });

  test("STRICT: the agent still cannot close its own MAIN task", () => {
    expect(() => s.update({ taskId: parentId, actor: "agent", by: "claude", agentTopicId: "top-1", patch: { status: "done" } }))
      .toThrow(/only a human/);
  });

  test("a different agent's topic does not unlock the step", () => {
    const step = s.create({ projectId: PID, text: "step", status: "backlog", parentTaskId: parentId });
    expect(() => s.update({ taskId: step.id, actor: "agent", by: "claude", agentTopicId: "top-2", patch: { status: "done" } }))
      .toThrow(/only a human/);
  });

  test("an unrelated top-level task stays gated even with agentTopicId set", () => {
    const other = s.create({ projectId: PID, text: "unrelated" });
    expect(() => s.update({ taskId: other.id, actor: "agent", by: "claude", agentTopicId: "top-1", patch: { status: "done" } }))
      .toThrow(/only a human/);
  });

  test("open_subtasks still gates a step that has its own open children", () => {
    const step = s.create({ projectId: PID, text: "step", status: "backlog", parentTaskId: parentId });
    s.create({ projectId: PID, text: "sub-step", status: "backlog", parentTaskId: step.id });
    expect(() => s.update({ taskId: step.id, actor: "agent", by: "claude", agentTopicId: "top-1", patch: { status: "done" } }))
      .toThrow(/open subtasks/);
  });
});

describe("boundRootOf (dispatch root of a subtree)", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  test("finds the bound ancestor from any depth (and self)", () => {
    db.run("INSERT INTO topics (id) VALUES ('top-1')");
    const root = s.create({ projectId: PID, text: "deliverable", status: "in_progress" });
    db.prepare("UPDATE tasks SET assigned_topic_id = 'top-1' WHERE id = ?").run(root.id);
    const step = s.create({ projectId: PID, text: "step", status: "backlog", parentTaskId: root.id });
    const sub = s.create({ projectId: PID, text: "sub-step", status: "backlog", parentTaskId: step.id });
    expect(s.boundRootOf(sub.id)?.id).toBe(root.id);
    expect(s.boundRootOf(step.id)?.id).toBe(root.id);
    expect(s.boundRootOf(root.id)?.id).toBe(root.id); // self counts
  });

  test("null when nothing in the chain is bound", () => {
    const a = s.create({ projectId: PID, text: "a" });
    const b = s.create({ projectId: PID, text: "b", parentTaskId: a.id });
    expect(s.boundRootOf(b.id)).toBeNull();
  });
});

describe("taskForTopic / taskByIdPrefix (task-owned browser fork)", () => {
  let db: Database;
  // Hex uuids so `taskByIdPrefix` (guarded on hex id8) is testable end to end.
  const hexSvc = (d: Database): TaskService => {
    let n = 0;
    return createTaskService(d, {
      now: () => "2026-07-18T10:00:00.000Z",
      uuid: () => `125aafd${n++}-0e15-4aa0-ab25-f00000000000`,
    });
  };
  beforeEach(() => { db = freshDb(); });

  test("taskForTopic returns the bound task's id/project/text, null for an unbound topic", () => {
    const s = hexSvc(db);
    db.run("INSERT INTO topics (id) VALUES ('top-1')");
    const t = s.create({ projectId: PID, text: "build the thing", status: "in_progress" });
    db.prepare("UPDATE tasks SET assigned_topic_id = 'top-1' WHERE id = ?").run(t.id);
    expect(s.taskForTopic("top-1")).toEqual({ id: t.id, projectId: PID, text: "build the thing" });
    expect(s.taskForTopic("top-nope")).toBeNull();
    expect(s.taskForTopic("")).toBeNull();
  });

  test("taskForTopic prefers a non-archived, most-recent binding", () => {
    const s = hexSvc(db);
    db.run("INSERT INTO topics (id) VALUES ('top-1')");
    const older = s.create({ projectId: PID, text: "older" });
    const newer = s.create({ projectId: PID, text: "newer" });
    db.prepare("UPDATE tasks SET assigned_topic_id='top-1', archived=1, updated_at='2026-07-18T09:00:00.000Z' WHERE id=?").run(older.id);
    db.prepare("UPDATE tasks SET assigned_topic_id='top-1', archived=0, updated_at='2026-07-18T11:00:00.000Z' WHERE id=?").run(newer.id);
    expect(s.taskForTopic("top-1")?.id).toBe(newer.id);
  });

  test("taskByIdPrefix resolves the `task-<id8>` hex prefix → { id, text }", () => {
    const s = hexSvc(db);
    const t = s.create({ projectId: PID, text: "hello world" });
    const id8 = t.id.slice(0, 8); // "125aafd0"
    expect(s.taskByIdPrefix(id8)).toEqual({ id: t.id, text: "hello world" });
    expect(s.taskByIdPrefix("125aafd0")).toEqual({ id: t.id, text: "hello world" });
  });

  test("taskByIdPrefix rejects non-hex / empty input and unknown prefixes", () => {
    const s = hexSvc(db);
    s.create({ projectId: PID, text: "x" });
    expect(s.taskByIdPrefix("")).toBeNull();
    expect(s.taskByIdPrefix("not-hex")).toBeNull(); // '-' and 'n/t' aren't hex
    expect(s.taskByIdPrefix("deadbeef")).toBeNull(); // valid hex, no match
  });
});

describe("moveToProject", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  test("moves the whole subtree; the root re-appends on the target board", () => {
    const root = s.create({ projectId: "pA", text: "root" });
    const step = s.create({ projectId: "pA", text: "step", status: "backlog", parentTaskId: root.id });
    const sub = s.create({ projectId: "pA", text: "sub", status: "backlog", parentTaskId: step.id });
    s.create({ projectId: "pB", text: "existing" }); // target board order 1
    const moved = s.moveToProject({ taskId: root.id, toProjectId: "pB" });
    expect(moved.projectId).toBe("pB");
    expect(moved.kanbanOrder).toBe(2);
    expect(s.get(step.id)!.task.projectId).toBe("pB");
    expect(s.get(sub.id)!.task.projectId).toBe("pB");
    expect(s.list({ scope: "project", projectId: "pA" }).length).toBe(0);
  });

  test("a subtask never moves alone (same-board parent invariant)", () => {
    const root = s.create({ projectId: "pA", text: "root" });
    const step = s.create({ projectId: "pA", text: "step", status: "backlog", parentTaskId: root.id });
    expect(() => s.moveToProject({ taskId: step.id, toProjectId: "pB" })).toThrow(/subtask/);
  });

  test("a task with a live agent stays put", () => {
    db.run("INSERT INTO topics (id) VALUES ('top-1')");
    const t = s.create({ projectId: "pA", text: "x", status: "in_progress" });
    db.prepare("UPDATE tasks SET assigned_topic_id = 'top-1' WHERE id = ?").run(t.id);
    expect(() => s.moveToProject({ taskId: t.id, toProjectId: "pB" })).toThrow(/live agent/);
  });

  test("same-board move is a no-op; projectId guard reports not_found", () => {
    const t = s.create({ projectId: "pA", text: "x" });
    expect(s.moveToProject({ taskId: t.id, toProjectId: "pA" }).projectId).toBe("pA");
    expect(() => s.moveToProject({ taskId: t.id, toProjectId: "pB", projectId: "pWRONG" })).toThrow(/not found/);
  });
});

describe("outputUrl (KANBAN-09 review panel)", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  test("http(s) URL persists and comes back from get()", () => {
    const t = s.create({ projectId: PID, text: "x" });
    const up = s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { outputUrl: "http://localhost:5173/preview" } });
    expect(up.outputUrl).toBe("http://localhost:5173/preview");
    expect(s.get(t.id)!.task.outputUrl).toBe("http://localhost:5173/preview");
  });

  test("non-http(s) schemes are rejected (iframe target: no LFI/XSS)", () => {
    const t = s.create({ projectId: PID, text: "x" });
    for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "ftp://x", "totally not a url"]) {
      expect(() => s.update({ taskId: t.id, actor: "human", by: "user", patch: { outputUrl: bad } }))
        .toThrow(/http\(s\)/);
    }
  });

  test("empty string (or null) clears it", () => {
    const t = s.create({ projectId: PID, text: "x" });
    s.update({ taskId: t.id, actor: "human", by: "user", patch: { outputUrl: "https://example.com" } });
    const cleared = s.update({ taskId: t.id, actor: "human", by: "user", patch: { outputUrl: "" } });
    expect(cleared.outputUrl).toBeNull();
  });
});

describe("archive", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  test("archived task drops off the list but the row is kept", () => {
    const t = s.create({ projectId: "p1", text: "x" });
    s.archive({ taskId: t.id, projectId: "p1" });
    expect(s.list({ scope: "project", projectId: "p1" }).length).toBe(0);
    expect(s.get(t.id)).not.toBeNull();
  });
  test("archive is projectId-guarded", () => {
    const t = s.create({ projectId: "p1", text: "x" });
    expect(() => s.archive({ taskId: t.id, projectId: "p2" })).toThrow(/not found/);
  });
});

describe("comments", () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });

  test("adds a comment with mentions round-trip", () => {
    const s = svc(db);
    const t = s.create({ projectId: PID, text: "work" });
    const c = s.addComment({ taskId: t.id, author: "claude", content: "fatto", mentions: ["attilio"] });
    expect(c.author).toBe("claude");
    expect(c.mentions).toEqual(["attilio"]);
    expect(s.get(t.id)!.comments.length).toBe(1);
  });

  test("dedupes identical author+content within the window", () => {
    const clock = { t: Date.parse("2026-07-09T10:00:00.000Z") };
    const s = svc(db, clock);
    const t = s.create({ projectId: PID, text: "work" });
    const a = s.addComment({ taskId: t.id, author: "claude", content: "same" });
    const b = s.addComment({ taskId: t.id, author: "claude", content: "same" });
    expect(b.id).toBe(a.id);
    expect(s.get(t.id)!.comments.length).toBe(1);
  });

  test("media round-trips (absolute paths only, capped at 8); attachment-only comments are legal", () => {
    const s = svc(db);
    const t = s.create({ projectId: PID, text: "x" });
    const c = s.addComment({
      taskId: t.id, author: "user", content: "guarda qui",
      media: ["/tmp/shot.png", "relative/nope.png", ...Array.from({ length: 10 }, (_, i) => `/tmp/f${i}.txt`)],
    });
    expect(c.media[0]).toBe("/tmp/shot.png");
    expect(c.media).not.toContain("relative/nope.png"); // non-absolute dropped
    expect(c.media.length).toBe(8); // capped
    expect(s.get(t.id)!.comments[0].media.length).toBe(8);
    // Attachment-only: no text → placeholder body, media kept.
    const only = s.addComment({ taskId: t.id, author: "user", content: "", media: ["/tmp/doc.pdf"] });
    expect(only.content).toBe("(allegato)");
    expect(only.media).toEqual(["/tmp/doc.pdf"]);
  });

  test("same content after the window is a new comment", () => {
    const clock = { t: Date.parse("2026-07-09T10:00:00.000Z") };
    const s = svc(db, clock);
    const t = s.create({ projectId: PID, text: "work" });
    s.addComment({ taskId: t.id, author: "claude", content: "same" });
    clock.t += 60_000; // past the 10s dedupe window
    const b = s.addComment({ taskId: t.id, author: "claude", content: "same" });
    expect(s.get(t.id)!.comments.length).toBe(2);
    expect(b).toBeTruthy();
  });
});

describe("nested tasks (subtask cascade)", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  test("creates a subtask under a parent; get() lists children; list() fills counters", () => {
    const parent = s.create({ projectId: PID, text: "epic" });
    const kid = s.create({ projectId: PID, text: "part 1", parentTaskId: parent.id });
    expect(kid.parentTaskId).toBe(parent.id);
    const got = s.get(parent.id)!;
    expect(got.children.map((c) => c.id)).toEqual([kid.id]);
    expect(got.task.subtaskCount).toBe(1);
    expect(got.task.subtaskDoneCount).toBe(0);
    const listed = s.list({ scope: "project", projectId: PID }).find((t) => t.id === parent.id)!;
    expect(listed.subtaskCount).toBe(1);
  });

  test("unlimited depth: a subtask can have its own subtasks", () => {
    const a = s.create({ projectId: PID, text: "a" });
    const b = s.create({ projectId: PID, text: "b", parentTaskId: a.id });
    const c = s.create({ projectId: PID, text: "c", parentTaskId: b.id });
    expect(s.get(b.id)!.children.map((x) => x.id)).toEqual([c.id]);
    expect(s.get(a.id)!.children.map((x) => x.id)).toEqual([b.id]);
  });

  test("parent must exist, be alive, and live on the SAME board", () => {
    expect(() => s.create({ projectId: PID, text: "x", parentTaskId: "ghost" })).toThrow(/not found/);
    const foreign = s.create({ projectId: "other-board", text: "y" });
    expect(() => s.create({ projectId: PID, text: "x", parentTaskId: foreign.id })).toThrow(/not found/);
    const dead = s.create({ projectId: PID, text: "z" });
    s.archive({ taskId: dead.id });
    expect(() => s.create({ projectId: PID, text: "x", parentTaskId: dead.id })).toThrow(/not found/);
  });

  test("a parent with open subtasks cannot go done — any actor, update or approve", () => {
    const parent = s.create({ projectId: PID, text: "epic" });
    const kid = s.create({ projectId: PID, text: "part", parentTaskId: parent.id });
    expect(() => s.update({ taskId: parent.id, actor: "human", by: "user", patch: { status: "done" } }))
      .toThrow(/open subtasks/);
    s.addComment({ taskId: parent.id, author: "claude", content: "fatto" });
    s.update({ taskId: parent.id, actor: "agent", by: "claude", patch: { status: "review" } });
    expect(() => s.reviewDecision({ taskId: parent.id, by: "user", decision: "approve" }))
      .toThrow(/open subtasks/);
    // Close the child → the parent can now complete.
    s.update({ taskId: kid.id, actor: "human", by: "user", patch: { status: "done" } });
    const done = s.reviewDecision({ taskId: parent.id, by: "user", decision: "approve" });
    expect(done.status).toBe("done");
  });

  test("archiving a parent archives the whole subtree (cascade, deep)", () => {
    const a = s.create({ projectId: PID, text: "a" });
    const b = s.create({ projectId: PID, text: "b", parentTaskId: a.id });
    const c = s.create({ projectId: PID, text: "c", parentTaskId: b.id });
    s.archive({ taskId: a.id });
    const archived = (id: string) => (db.prepare("SELECT archived FROM tasks WHERE id = ?").get(id) as any).archived;
    expect(archived(a.id)).toBe(1);
    expect(archived(b.id)).toBe(1);
    expect(archived(c.id)).toBe(1);
  });

  test("archived subtasks don't count and unblock the parent", () => {
    const parent = s.create({ projectId: PID, text: "epic" });
    const kid = s.create({ projectId: PID, text: "part", parentTaskId: parent.id });
    s.archive({ taskId: kid.id });
    expect(s.get(parent.id)!.task.subtaskCount).toBe(0);
    const done = s.update({ taskId: parent.id, actor: "human", by: "user", patch: { status: "done" } });
    expect(done.status).toBe("done");
  });
});

describe("addComment — question block (server-composed)", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  test("questionOptions compose the CANONICAL block: fences + newlines + '- ' options", () => {
    const t = s.create({ projectId: PID, text: "w" });
    const c = s.addComment({
      taskId: t.id, author: "agent-1",
      content: "Quale approccio uso?",
      questionOptions: ["JWT in cookie", "Bearer token"],
    });
    expect(c.content).toBe("```question\nQuale approccio uso?\n- JWT in cookie\n- Bearer token\n```");
  });

  test("newlines inside the question are flattened (the block stays parseable)", () => {
    const t = s.create({ projectId: PID, text: "w" });
    const c = s.addComment({
      taskId: t.id, author: "agent-1",
      content: "Domanda\nsu due righe?",
      questionOptions: ["sì"],
    });
    expect(c.content).toBe("```question\nDomanda su due righe?\n- sì\n```");
  });

  test("rejects fences inside a question (no nested blocks) and all-empty options", () => {
    const t = s.create({ projectId: PID, text: "w" });
    expect(() => s.addComment({ taskId: t.id, author: "a", content: "```question hack```", questionOptions: ["x"] }))
      .toThrow(TaskServiceError);
    expect(() => s.addComment({ taskId: t.id, author: "a", content: "ok?", questionOptions: ["  ", ""] }))
      .toThrow(TaskServiceError);
  });

  test("without questionOptions the content is stored verbatim", () => {
    const t = s.create({ projectId: PID, text: "w" });
    const c = s.addComment({ taskId: t.id, author: "a", content: "nota semplice" });
    expect(c.content).toBe("nota semplice");
  });
});

describe("claim (atomic dispatch)", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  const todo = () => { const t = s.create({ projectId: PID, text: "w", status: "todo" }); return t; };

  test("claims a todo task: → in_progress + 'starting', attempts=1, NO topic binding yet", () => {
    const t = todo();
    const claimed = s.claim({ taskId: t.id, cap: 2, maxAttempts: 3 });
    expect(claimed).not.toBeNull();
    expect(claimed!.status).toBe("in_progress");
    // The binding arrives via bindTopic() once the REAL topic exists —
    // assigned_topic_id has a FK to topics(id), placeholders would violate it.
    expect(claimed!.assignedTopicId).toBeNull();
    expect(claimed!.dispatchState).toBe("starting");
    expect(claimed!.dispatchAttempts).toBe(1);
  });

  test("bindTopic attaches the real topic to a claimed task (FK enforced)", () => {
    const t = todo();
    s.claim({ taskId: t.id, cap: 2, maxAttempts: 3 });
    db.run("INSERT INTO topics (id) VALUES ('top-1')");
    const bound = s.bindTopic({ taskId: t.id, topicId: "top-1" });
    expect(bound.assignedTopicId).toBe("top-1");
    // A topic id that does not exist must be rejected by the schema.
    expect(() => s.bindTopic({ taskId: t.id, topicId: "pending:" + t.id })).toThrow();
  });

  test("idempotent: a second claim on the same task returns null (no double dispatch)", () => {
    const t = todo();
    expect(s.claim({ taskId: t.id, cap: 2, maxAttempts: 3 })).not.toBeNull();
    expect(s.claim({ taskId: t.id, cap: 2, maxAttempts: 3 })).toBeNull();
    expect(s.get(t.id)!.task.dispatchAttempts).toBe(1); // not double-counted
  });

  test("concurrency cap: no free slot → null, task stays todo", () => {
    const a = todo(); const b = todo();
    expect(s.claim({ taskId: a.id, cap: 1, maxAttempts: 3 })).not.toBeNull();
    const bClaim = s.claim({ taskId: b.id, cap: 1, maxAttempts: 3 });
    expect(bClaim).toBeNull();
    expect(s.get(b.id)!.task.status).toBe("todo");
    expect(s.get(b.id)!.task.dispatchAttempts).toBe(0); // not consumed when capped out
  });

  test("retry cap: attempts >= maxAttempts → null", () => {
    const t = todo();
    // burn attempts via claim+release(requeue) cycles
    s.claim({ taskId: t.id, cap: 5, maxAttempts: 2 });
    s.release({ taskId: t.id, requeue: true });
    s.claim({ taskId: t.id, cap: 5, maxAttempts: 2 });
    s.release({ taskId: t.id, requeue: true });
    // attempts now 2 == cap → refuse
    expect(s.get(t.id)!.task.dispatchAttempts).toBe(2);
    expect(s.claim({ taskId: t.id, cap: 5, maxAttempts: 2 })).toBeNull();
  });

  test("only claims 'todo' — a backlog task is not eligible", () => {
    const t = s.create({ projectId: PID, text: "w", status: "backlog" });
    expect(s.claim({ taskId: t.id, cap: 5, maxAttempts: 3 })).toBeNull();
  });
});

describe("release", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  test("requeue=true → todo, binding cleared, attempts preserved, note posted", () => {
    const t = s.create({ projectId: PID, text: "w", status: "todo" });
    s.claim({ taskId: t.id, cap: 2, maxAttempts: 3 });
    db.run("INSERT INTO topics (id) VALUES ('top-1')");
    s.bindTopic({ taskId: t.id, topicId: "top-1" });
    const r = s.release({ taskId: t.id, requeue: true, reason: "worked in topic top-1", by: "system" });
    expect(r.status).toBe("todo");
    expect(r.assignedTopicId).toBeNull();
    expect(r.dispatchState).toBe("queued");
    expect(r.dispatchAttempts).toBe(1); // preserved so the retry cap still bites
    expect(s.get(t.id)!.comments.some((c) => c.content.includes("top-1"))).toBe(true);
  });

  test("requeue=false → parked in backlog with binding cleared", () => {
    const t = s.create({ projectId: PID, text: "w", status: "todo" });
    s.claim({ taskId: t.id, cap: 2, maxAttempts: 3 });
    const r = s.release({ taskId: t.id, requeue: false, reason: "gave up" });
    expect(r.status).toBe("backlog");
    expect(r.assignedTopicId).toBeNull();
    expect(r.dispatchState).toBeNull();
  });
});

describe("board settings", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  test("defaults when no row exists (auto off, cap 2, worktree on)", () => {
    const bs = s.getBoardSettings(PID);
    expect(bs.autoDispatch).toBe(false);
    expect(bs.maxAgents).toBe(2);
    expect(bs.dispatchEffort).toBe("medium");
    expect(bs.dispatchUseWorktree).toBe(true);
  });

  test("upsert persists + clamps + reads back", () => {
    const bs = s.updateBoardSettings(PID, { autoDispatch: true, maxAgents: 99, dispatchTimeoutMin: 20 });
    expect(bs.autoDispatch).toBe(true);
    expect(bs.maxAgents).toBe(10); // clamped 1..10
    expect(s.getBoardSettings(PID).autoDispatch).toBe(true);
  });

  test("rejects an invalid effort", () => {
    expect(() => s.updateBoardSettings(PID, { dispatchEffort: "turbo" })).toThrow(TaskServiceError);
  });

  test("enabling auto-dispatch alone keeps the cap at 2 (not the legacy column default 5)", () => {
    const bs = s.updateBoardSettings(PID, { autoDispatch: true });
    expect(bs.maxAgents).toBe(2);
    expect(s.getBoardSettings(PID).maxAgents).toBe(2);
  });

  test("auto-dispatch is GLOBAL: flipping it from one board flips every board", () => {
    expect(s.getGlobalAutoDispatch()).toBe(false);
    s.updateBoardSettings(PID, { autoDispatch: true });
    expect(s.getGlobalAutoDispatch()).toBe(true);
    // A completely different board reads the same switch…
    expect(s.getBoardSettings("other-board-zzz999").autoDispatch).toBe(true);
    // …and the dedicated setter flips it back for everyone.
    expect(s.setGlobalAutoDispatch(false)).toBe(false);
    expect(s.getBoardSettings(PID).autoDispatch).toBe(false);
  });

  test("global switch does not leak per-board config across boards", () => {
    s.updateBoardSettings(PID, { autoDispatch: true, maxAgents: 7, dispatchEffort: "max" });
    const other = s.getBoardSettings("other-board-zzz999");
    expect(other.autoDispatch).toBe(true); // global
    expect(other.maxAgents).toBe(2); // per-board default, untouched
    expect(other.dispatchEffort).toBe("medium");
  });

  test("reviewDecision clears the dispatch chip on approve", () => {
    const t = s.create({ projectId: PID, text: "x" });
    // Drive it to review with a dispatch chip set, then approve.
    s.update({ taskId: t.id, actor: "human", by: "u", patch: { status: "review" } });
    s.setDispatchState({ taskId: t.id, state: "needs_input" });
    const done = s.reviewDecision({ taskId: t.id, by: "u", decision: "approve" });
    expect(done.status).toBe("done");
    expect(done.dispatchState).toBeNull();
  });
});

describe("blocked-by dependency", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  test("claim refuses a todo whose blocker is still open; unblocks at done", () => {
    const a = s.create({ projectId: PID, text: "blocker" });
    const b = s.create({ projectId: PID, text: "dependent", blockedByTaskId: a.id });
    expect(b.blockedByTaskId).toBe(a.id);
    expect(s.isDispatchBlocked(b.id)).toBe(true);
    expect(s.claim({ taskId: b.id, cap: 5, maxAttempts: 3 })).toBeNull();
    // Blocker completes → same claim now succeeds.
    s.update({ taskId: a.id, actor: "human", by: "u", patch: { status: "done" } });
    expect(s.isDispatchBlocked(b.id)).toBe(false);
    expect(s.claim({ taskId: b.id, cap: 5, maxAttempts: 3 })).not.toBeNull();
  });

  test("an archived blocker does not block", () => {
    const a = s.create({ projectId: PID, text: "blocker" });
    const b = s.create({ projectId: PID, text: "dependent", blockedByTaskId: a.id });
    s.archive({ taskId: a.id });
    expect(s.isDispatchBlocked(b.id)).toBe(false);
  });

  test("self-block and cycles are rejected; clearing works", () => {
    const a = s.create({ projectId: PID, text: "a" });
    const b = s.create({ projectId: PID, text: "b" });
    s.update({ taskId: b.id, actor: "human", by: "u", patch: { blockedByTaskId: a.id } });
    expect(() => s.update({ taskId: a.id, actor: "human", by: "u", patch: { blockedByTaskId: a.id } })).toThrow();
    // a ← b already; blocking a on b would close the loop.
    expect(() => s.update({ taskId: a.id, actor: "human", by: "u", patch: { blockedByTaskId: b.id } })).toThrow();
    const cleared = s.update({ taskId: b.id, actor: "human", by: "u", patch: { blockedByTaskId: null } });
    expect(cleared.blockedByTaskId).toBeNull();
  });

  test("listBlockedBy returns the alive dependents", () => {
    const a = s.create({ projectId: PID, text: "a" });
    const b = s.create({ projectId: PID, text: "b", blockedByTaskId: a.id });
    const c = s.create({ projectId: PID, text: "c", blockedByTaskId: a.id });
    s.archive({ taskId: c.id });
    const deps = s.listBlockedBy(a.id).map((t) => t.id);
    expect(deps).toEqual([b.id]);
  });

  test("model and reuseBlockerContext persist through create/update", () => {
    const a = s.create({ projectId: PID, text: "a" });
    const b = s.create({ projectId: PID, text: "b", blockedByTaskId: a.id, reuseBlockerContext: true, model: "claude-fable-5" });
    expect(b.model).toBe("claude-fable-5");
    expect(b.reuseBlockerContext).toBe(true);
    const upd = s.update({ taskId: b.id, actor: "human", by: "u", patch: { model: null, reuseBlockerContext: false } });
    expect(upd.model).toBeNull();
    expect(upd.reuseBlockerContext).toBe(false);
  });
});

describe("priorità automatica", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  test("auto finché nessuno la sceglie; un write esplicito la fissa", () => {
    const t = s.create({ projectId: PID, text: "x" });
    expect(t.priorityAuto).toBe(true);
    const chosen = s.create({ projectId: PID, text: "y", priority: 4 });
    expect(chosen.priorityAuto).toBe(false);
    const upd = s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { priority: 3 } });
    expect(upd.priority).toBe(3);
    expect(upd.priorityAuto).toBe(false);
  });
});
