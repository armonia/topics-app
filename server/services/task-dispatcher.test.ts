import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { createTaskService, type TaskService } from "./tasks";
import { createTaskDispatcher, type DispatcherDeps } from "./task-dispatcher";

// Self-contained schema (mirrors migrations 001 + 026 + 031, tasks-relevant
// subset). PRAGMA foreign_keys + the assigned_topic_id FK are faithful to prod
// on purpose: the "pending:<taskId>" placeholder bug only reproduced with the
// FK enforced.
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
    parent_task_id TEXT REFERENCES tasks(id), output_url TEXT
  )`);
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

const PID = "alpha-abc123";

let seq = 0;
function seedTask(
  db: Database,
  o: { id?: string; status?: string; attempts?: number; assignedTopicId?: string | null; dispatchState?: string | null; createdAt?: string } = {},
): string {
  const id = o.id ?? `t${++seq}`;
  const ts = o.createdAt ?? new Date(Date.now() + seq).toISOString();
  // FK: a seeded binding needs its topics row, like in prod.
  if (o.assignedTopicId) db.run("INSERT OR IGNORE INTO topics (id) VALUES (?)", [o.assignedTopicId]);
  db.run(
    `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, dispatch_attempts, assigned_topic_id, dispatch_state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, PID, "task " + id, o.status ?? "todo", ts, ts, o.attempts ?? 0, o.assignedTopicId ?? null, o.dispatchState ?? null],
  );
  return id;
}

/** A controllable harness: real service, fake host side-effects, manual turn control. */
function harness(overrides: Partial<DispatcherDeps> = {}) {
  const db = freshDb();
  const svc: TaskService = createTaskService(db);
  const events: any[] = [];
  const worktreesCreated: string[] = [];
  const topicsCreated: { name: string; projectPath: string; worktreeId?: string; effort?: string }[] = [];
  const turns: { sessionKey: string; content: string }[] = [];
  let resolveTurn: (() => void) | null = null;
  let rejectTurn: ((e: unknown) => void) | null = null;

  const deps: DispatcherDeps = {
    svc,
    resolveProject: () => ({ path: "/Users/x/Projects/alpha", projectStoreId: "store-1" }),
    createTopic: (opts) => {
      topicsCreated.push({ name: opts.name, projectPath: opts.projectPath, worktreeId: opts.worktreeId, effort: opts.effort });
      const n = topicsCreated.length;
      // The real host persists the topic row; the FK on assigned_topic_id
      // requires it to exist before bindTopic().
      db.run("INSERT OR IGNORE INTO topics (id) VALUES (?)", [`topic-${n}`]);
      return { topicId: `topic-${n}`, sessionKey: `topic:sk${n}` };
    },
    createWorktree: async (storeId) => { worktreesCreated.push(storeId); return `wt-${storeId}`; },
    runTurn: (sessionKey, content) =>
      new Promise<void>((res, rej) => { turns.push({ sessionKey, content }); resolveTurn = res; rejectTurn = rej; }),
    broadcast: (m) => events.push(m),
    graceMs: 10,
    log: () => {},
    ...overrides,
  };
  const dispatcher = createTaskDispatcher(deps);
  return {
    db, svc, dispatcher, events, worktreesCreated, topicsCreated, turns,
    finishTurn: () => { resolveTurn?.(); },
    failTurn: (e: unknown) => { rejectTurn?.(e); },
    task: (id: string) => svc.get(id)?.task,
  };
}

const flush = async (n = 8) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

describe("task-dispatcher", () => {
  it("is a no-op when auto_dispatch is off", async () => {
    const h = harness();
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.task("t1")!.status).toBe("todo");
    expect(h.turns.length).toBe(0);
    expect(h.dispatcher.isInFlight("t1")).toBe(false);
  });

  it("claims + launches a todo: worktree → topic → working chip → turn", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true, maxAgents: 2 });
    seedTask(h.db, { id: "t1", status: "todo" });

    await h.dispatcher.tick(PID);
    await flush();

    const t = h.task("t1")!;
    expect(t.status).toBe("in_progress");
    expect(t.assignedTopicId).toBe("topic-1");      // rebound from placeholder → real topic
    expect(t.dispatchState).toBe("working");
    expect(t.dispatchAttempts).toBe(1);
    expect(h.worktreesCreated).toEqual(["store-1"]);
    expect(h.topicsCreated[0].worktreeId).toBe("wt-store-1");
    expect(h.turns.length).toBe(1);
    expect(h.turns[0].sessionKey).toBe("topic:sk1");
    expect(h.turns[0].content).toContain("owner esclusivo del task");
    expect(h.dispatcher.isInFlight("t1")).toBe(true);
  });

  it("leaves a task alone when the turn ends in review", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    // Agent moved it to review mid-turn (allowed: agent→review, after its summary).
    h.svc.addComment({ taskId: "t1", author: "claude", content: "fatto" });
    h.svc.update({ taskId: "t1", actor: "agent", by: "claude", patch: { status: "review" } });
    h.finishTurn();
    await flush();
    const t = h.task("t1")!;
    expect(t.status).toBe("review");
    expect(t.assignedTopicId).toBe("topic-1");   // binding preserved for the human
    expect(t.dispatchState).toBe("needs_input");  // chip flips to "serve te", not stale "working"
    expect(h.dispatcher.isInFlight("t1")).toBe(false);
  });

  it("requeues a task whose turn ended without reaching review", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    h.finishTurn(); // ends while still in_progress
    await flush();
    const t = h.task("t1")!;
    expect(t.status).toBe("todo");
    expect(t.assignedTopicId).toBeNull();
    expect(t.dispatchState).toBe("queued");
  });

  it("respects the concurrency cap", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true, maxAgents: 1 });
    seedTask(h.db, { id: "t1", status: "todo", createdAt: "2020-01-01T00:00:00.000Z" });
    seedTask(h.db, { id: "t2", status: "todo", createdAt: "2020-01-02T00:00:00.000Z" });
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.task("t1")!.status).toBe("in_progress"); // oldest claimed
    expect(h.task("t2")!.status).toBe("todo");         // cap hit → stays queued
    expect(h.turns.length).toBe(1);
  });

  it("parks (does not run in-place) when a worktree is required but unavailable", async () => {
    const h = harness({ resolveProject: () => ({ path: "/Users/x/Projects/alpha", projectStoreId: null }) });
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: true });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    const t = h.task("t1")!;
    expect(t.status).toBe("backlog");          // parked, NOT run in the live repo
    expect(t.assignedTopicId).toBeNull();
    expect(t.dispatchError).toContain("worktree");
    expect(h.turns.length).toBe(0);
  });

  it("runs in-place (no worktree) when the board opts out", async () => {
    const h = harness({ resolveProject: () => ({ path: "/Users/x/Projects/alpha", projectStoreId: null }) });
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: false });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.task("t1")!.status).toBe("in_progress");
    expect(h.worktreesCreated.length).toBe(0);
    expect(h.topicsCreated[0].worktreeId).toBeUndefined();
    expect(h.turns.length).toBe(1);
  });

  it("onEnterTodo debounces then launches after the grace window", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "todo" });
    h.dispatcher.onEnterTodo(PID, "t1");
    expect(h.task("t1")!.dispatchState).toBe("queued"); // chip shows immediately
    expect(h.turns.length).toBe(0);                     // but no launch yet
    await new Promise((r) => setTimeout(r, 40));
    await flush();
    expect(h.task("t1")!.status).toBe("in_progress");
    expect(h.turns.length).toBe(1);
  });

  it("onEnterTodo does nothing when auto_dispatch is off (no lingering chip)", async () => {
    const h = harness(); // auto_dispatch defaults off
    seedTask(h.db, { id: "t1", status: "todo" });
    h.dispatcher.onEnterTodo(PID, "t1");
    await new Promise((r) => setTimeout(r, 40));
    await flush();
    expect(h.task("t1")!.dispatchState).toBeNull();
    expect(h.task("t1")!.status).toBe("todo");
    expect(h.turns.length).toBe(0);
  });

  it("onLeaveTodo cancels a queued launch inside the grace window", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "todo" });
    h.dispatcher.onEnterTodo(PID, "t1");
    h.dispatcher.onLeaveTodo("t1"); // dragged back out immediately
    await new Promise((r) => setTimeout(r, 40));
    await flush();
    expect(h.task("t1")!.status).toBe("todo");
    expect(h.task("t1")!.dispatchState).toBeNull();
    expect(h.turns.length).toBe(0);
  });

  it("resume re-kicks the SAME topic with the human message", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "in_progress", assignedTopicId: "topic-42", attempts: 1 });

    const p = h.dispatcher.resume("t1", "usa l'opzione B");
    await flush();
    expect(h.turns.length).toBe(1);
    expect(h.turns[0].sessionKey).toBe("topic:" + "topic-42".slice(0, 8)); // derived, same tab
    expect(h.turns[0].content).toContain("usa l'opzione B");
    expect(h.task("t1")!.dispatchState).toBe("working");
    // Agent finishes back into review (its earlier comments already count).
    h.svc.addComment({ taskId: "t1", author: "claude", content: "sistemato con opzione B" });
    h.svc.update({ taskId: "t1", actor: "agent", by: "claude", patch: { status: "review" } });
    h.finishTurn();
    await p;
    await flush();
    expect(h.task("t1")!.status).toBe("review");
    expect(h.dispatcher.isInFlight("t1")).toBe(false);
  });

  it("resume is a no-op when the task has no bound topic", async () => {
    const h = harness();
    seedTask(h.db, { id: "t1", status: "in_progress", assignedTopicId: null });
    await h.dispatcher.resume("t1", "hey");
    await flush();
    expect(h.turns.length).toBe(0);
  });

  it("reconcile requeues an orphaned (mid-dispatch) in-progress task", async () => {
    const h = harness();
    seedTask(h.db, { id: "t1", status: "in_progress", assignedTopicId: "topic-dead", attempts: 1, dispatchState: "working" });
    await h.dispatcher.reconcile();
    await flush();
    const t = h.task("t1")!;
    expect(t.status).toBe("todo");            // requeued (attempts 1 < cap)
    expect(t.assignedTopicId).toBeNull();
  });

  it("reconcile parks an orphan whose attempts are exhausted", async () => {
    const h = harness();
    seedTask(h.db, { id: "t1", status: "in_progress", assignedTopicId: "topic-dead", attempts: 3, dispatchState: "working" });
    await h.dispatcher.reconcile();
    await flush();
    expect(h.task("t1")!.status).toBe("backlog"); // parked
  });

  it("reconcile leaves a human-moved bound task alone (chip not active)", async () => {
    // A human dragged a review/done card (dispatch_state null) into In Progress —
    // it's bound but NOT a dead dispatch, so reconcile must not "orphan" it.
    const h = harness();
    seedTask(h.db, { id: "t1", status: "in_progress", assignedTopicId: "topic-live", attempts: 1, dispatchState: null });
    await h.dispatcher.reconcile();
    await flush();
    const t = h.task("t1")!;
    expect(t.status).toBe("in_progress");
    expect(t.assignedTopicId).toBe("topic-live");
  });

  it("launch parks (not requeues) when setup fails and attempts are exhausted", async () => {
    const h = harness({ createWorktree: async () => { throw new Error("git worktree add failed"); } });
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "todo", attempts: 2 }); // claim bumps to 3 = RETRY_CAP
    await h.dispatcher.tick(PID);
    await flush();
    const t = h.task("t1")!;
    expect(t.status).toBe("backlog");   // parked, not stranded in todo
    expect(t.dispatchError).toContain("fallito");
    expect(h.turns.length).toBe(0);
  });

  it("parks todos with a visible reason when the board can't be resolved", async () => {
    const h = harness({ resolveProject: () => null });
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "todo", dispatchState: "queued" });
    await h.dispatcher.tick(PID);
    await flush();
    const t = h.task("t1")!;
    expect(t.status).toBe("backlog");                       // parked, not stranded on "queued"
    expect(t.dispatchState).toBeNull();
    expect(t.dispatchError).toContain("directory del progetto");
    expect(h.turns.length).toBe(0);
    // The reason is also in the thread, so the human sees WHY from the card.
    const comments = h.svc.get("t1")!.comments;
    expect(comments.some((c) => c.content.includes("directory del progetto"))).toBe(true);
  });

  it("passes the board's dispatch effort to the agent topic", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchEffort: "max" });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.topicsCreated[0].effort).toBe("max");
  });

  it("kickoff instructs update_task with the real tool signature (no project_id)", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.turns[0].content).toContain('update_task(task_id="t1", status="review")');
    expect(h.turns[0].content).not.toContain("project_id");
  });

  it("kickoff teaches the step checklist (nested subtasks, self-closable) and output_url", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    const kickoff = h.turns[0].content;
    expect(kickoff).toContain('parent_task_id="t1"');
    expect(kickoff).toContain('status="done"'); // marca ogni step done
    expect(kickoff).toContain("TUTTI i tuoi step devono essere done");
    expect(kickoff).toContain("output_url");
  });

  it("buffers a resume landing while the turn is in flight and delivers it on the same tab at turn end", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    // Agent delivers to review mid-turn (the turn has NOT ended yet)…
    h.svc.addComment({ taskId: "t1", author: "claude", content: "fatto" });
    h.svc.update({ taskId: "t1", actor: "agent", by: "claude", patch: { status: "review" } });
    // …and the human answers in that window: reject + resume (the route path).
    h.svc.reviewDecision({ taskId: "t1", by: "user", decision: "reject", comment: "aggiusta X" });
    void h.dispatcher.resume("t1", "aggiusta X");
    await flush();
    expect(h.turns.length).toBe(1); // buffered, not dropped, not double-run
    h.finishTurn();
    await flush();
    await new Promise((r) => setTimeout(r, 10)); // deferred delivery tick
    await flush();
    expect(h.turns.length).toBe(2);
    expect(h.turns[1].content).toContain("aggiusta X");
    expect(h.turns[1].sessionKey).toBe("topic:" + "topic-1".slice(0, 8)); // SAME tab
    expect(h.task("t1")!.status).toBe("in_progress"); // not requeued as an orphan
  });

  it("onEnterTodo re-dispatches a task dragged back from review (clears stale binding)", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    // Bound task now sitting in todo (human dragged it back from review).
    seedTask(h.db, { id: "t1", status: "todo", assignedTopicId: "topic-old", dispatchState: "needs_input" });
    h.dispatcher.onEnterTodo(PID, "t1");
    // Binding cleared immediately so it's eligible for a fresh claim.
    expect(h.task("t1")!.assignedTopicId).toBeNull();
    await new Promise((r) => setTimeout(r, 40));
    await flush();
    expect(h.task("t1")!.status).toBe("in_progress");
    expect(h.task("t1")!.assignedTopicId).toBe("topic-1"); // fresh topic, not the old one
  });
});
