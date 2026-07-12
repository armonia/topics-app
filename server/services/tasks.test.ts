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
    dispatch_attempts INTEGER NOT NULL DEFAULT 0, dispatch_state TEXT, dispatch_error TEXT
  )`);
  db.run(`CREATE UNIQUE INDEX idx_tasks_claude_task_id ON tasks(claude_task_id) WHERE claude_task_id IS NOT NULL`);
  db.run(`CREATE TABLE board_settings (
    project_id TEXT PRIMARY KEY, require_approval_for_done INTEGER DEFAULT 0,
    require_review_before_done INTEGER DEFAULT 0, block_status_with_pending INTEGER DEFAULT 0,
    only_lead_can_change_status INTEGER DEFAULT 0, max_agents INTEGER DEFAULT 5, auto_expire_hours INTEGER DEFAULT 24,
    auto_dispatch INTEGER NOT NULL DEFAULT 0, dispatch_effort TEXT NOT NULL DEFAULT 'medium',
    dispatch_use_worktree INTEGER NOT NULL DEFAULT 1, dispatch_timeout_min INTEGER NOT NULL DEFAULT 20
  )`);
  db.run(`CREATE TABLE task_comments (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author TEXT NOT NULL DEFAULT 'user',
    content TEXT NOT NULL, mentions TEXT, created_at TEXT NOT NULL
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
    const r = s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });
    expect(r.status).toBe("review");
    const ap = db.prepare("SELECT * FROM approvals WHERE task_id = ?").get(t.id) as any;
    expect(ap.approval_type).toBe("review");
    expect(ap.status).toBe("pending");
    expect(ap.requested_by).toBe("claude");
  });

  test("human approve → done, approval approved, completed_at set", () => {
    const t = s.create({ projectId: PID, text: "work" });
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
    s.update({ taskId: t.id, actor: "agent", by: "claude", patch: { status: "review" } });
    const back = s.reviewDecision({ taskId: t.id, by: "attilio", decision: "reject", comment: "manca il test" });
    expect(back.status).toBe("in_progress");
    const got = s.get(t.id)!;
    expect(got.comments.some(c => c.content === "manca il test")).toBe(true);
    const ap = db.prepare("SELECT * FROM approvals WHERE task_id = ?").get(t.id) as any;
    expect(ap.status).toBe("rejected");
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
