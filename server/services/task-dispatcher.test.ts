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
    parent_task_id TEXT REFERENCES tasks(id), output_url TEXT, plan_first INTEGER NOT NULL DEFAULT 0,
    agent_ms INTEGER NOT NULL DEFAULT 0, agent_tokens INTEGER NOT NULL DEFAULT 0,
    agent_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    model TEXT, blocked_by_task_id TEXT REFERENCES tasks(id), reuse_blocker_context INTEGER NOT NULL DEFAULT 0,
    priority_auto INTEGER NOT NULL DEFAULT 1
  )`);
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
  const topicsCreated: { name: string; projectPath: string; worktreeId?: string; effort?: string; model?: string; standalone?: boolean }[] = [];
  const turns: { sessionKey: string; content: string; contextMode?: "full" | "lean" }[] = [];
  let resolveTurn: (() => void) | null = null;
  let rejectTurn: ((e: unknown) => void) | null = null;

  const deps: DispatcherDeps = {
    svc,
    resolveProject: () => ({ path: "/Users/x/Projects/alpha", projectStoreId: "store-1" }),
    createTopic: (opts) => {
      topicsCreated.push({ name: opts.name, projectPath: opts.projectPath, worktreeId: opts.worktreeId, effort: opts.effort, model: opts.model, standalone: opts.standalone });
      const n = topicsCreated.length;
      // The real host persists the topic row; the FK on assigned_topic_id
      // requires it to exist before bindTopic().
      db.run("INSERT OR IGNORE INTO topics (id) VALUES (?)", [`topic-${n}`]);
      return { topicId: `topic-${n}`, sessionKey: `topic:sk${n}` };
    },
    createWorktree: async (storeId) => { worktreesCreated.push(storeId); return `wt-${storeId}`; },
    runTurn: (sessionKey, content, opts) =>
      new Promise<void>((res, rej) => { turns.push({ sessionKey, content, contextMode: opts?.contextMode }); resolveTurn = res; rejectTurn = rej; }),
    broadcast: (m) => events.push(m),
    graceMs: 10,
    retryBackoffMs: 0, // instant harness turns must not wait out the outage backoff
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

  it("self-heals a DEAD binding: a todo bound to a reaped topic dispatches again", async () => {
    // A task that ran before, reached done, then was dragged back to todo — its
    // agent topic was reaped in between, so `assigned_topic_id` now dangles.
    // Without the heal it would be skipped forever by the `!assignedTopicId`
    // eligibility filter and sit in todo with no chip.
    const h = harness({ topicExists: (id) => id !== "reaped-topic" });
    h.svc.updateBoardSettings(PID, { autoDispatch: true, maxAgents: 2 });
    seedTask(h.db, { id: "t1", status: "todo", assignedTopicId: "reaped-topic" });
    // Reap the topic row the way prod does — via a path that bypasses the FK
    // (the topics(id) FK on assigned_topic_id has no ON DELETE SET NULL, so a
    // normal delete is refused; the dangling binding is precisely what results).
    h.db.run("PRAGMA foreign_keys=OFF");
    h.db.run("DELETE FROM topics WHERE id = ?", ["reaped-topic"]);
    h.db.run("PRAGMA foreign_keys=ON");

    await h.dispatcher.tick(PID);
    await flush();

    const t = h.task("t1")!;
    expect(t.status).toBe("in_progress");        // claimed, not stranded
    expect(t.assignedTopicId).toBe("topic-1");   // dead link cleared → rebound to a fresh topic
    expect(t.dispatchState).toBe("working");
    expect(h.turns.length).toBe(1);              // an agent turn actually started
  });

  it("leaves a todo bound to a LIVE topic untouched (no false heal)", async () => {
    // A live binding means a dispatch is already in flight for it — the heal
    // must not release it. topicExists returns true, so it stays as-is.
    const h = harness({ topicExists: () => true });
    h.svc.updateBoardSettings(PID, { autoDispatch: true, maxAgents: 2 });
    seedTask(h.db, { id: "t1", status: "todo", assignedTopicId: "live-topic", dispatchState: "working" });

    await h.dispatcher.tick(PID);
    await flush();

    const t = h.task("t1")!;
    expect(t.assignedTopicId).toBe("live-topic"); // untouched
    expect(h.turns.length).toBe(0);               // never re-claimed
  });

  it("never claims a STEP as an independent task (todo subtask = checklist, not work item)", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    const parentId = seedTask(h.db, { id: "root1", status: "in_progress" });
    // A step sitting in todo (human dragged it, or created it there).
    const step = h.svc.create({ projectId: PID, text: "step", parentTaskId: parentId, status: "todo" });

    // Neither the enter-todo signal nor the poll may touch it.
    h.dispatcher.onEnterTodo(PID, step.id);
    await new Promise((r) => setTimeout(r, 30)); // past graceMs=10
    await h.dispatcher.tick(PID);
    await flush();

    const t = h.task(step.id)!;
    expect(t.status).toBe("todo");
    expect(t.dispatchState).toBeNull(); // no stranded "queued" chip either
    expect(t.assignedTopicId).toBeNull();
    expect(h.turns.length).toBe(0);
  });

  it("books wall-clock + usage delta (billable + cache reads) on the task at each turn end", async () => {
    // Fake transcript usage: zeros before the turn, real numbers after it.
    let usage = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, billableTokens: 0 };
    const h = harness({ getSessionUsage: () => usage });
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();

    // The turn consumed these (billable = in+out+cacheWrite, dedup upstream).
    usage = { inputTokens: 34, outputTokens: 200, cacheWriteTokens: 1000, cacheReadTokens: 55_000, billableTokens: 1234 };
    h.finishTurn();
    await flush();

    const t = h.task("t1")!;
    expect(t.agentTokens).toBe(1234);
    expect(t.agentCacheReadTokens).toBe(55_000);
    expect(t.agentMs).toBeGreaterThanOrEqual(0);
    // The metric update is broadcast so the open drawer refreshes live.
    expect(h.events.some((e) => e.type === "task:updated" && e.task?.agentTokens === 1234)).toBe(true);
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
    // Clean delivery (last agent word is NOT a question) → "delivered", not a
    // stale "working" nor a false "serve te".
    expect(t.dispatchState).toBe("delivered");
    expect(h.dispatcher.isInFlight("t1")).toBe(false);
  });

  it("a question as the agent's last word flips the chip to needs_input ('serve te')", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    // The agent asks (server-composed question block) and hands off to review.
    h.svc.addComment({ taskId: "t1", author: "claude", content: "Quale opzione?", questionOptions: ["A", "B"] });
    h.svc.update({ taskId: "t1", actor: "agent", by: "claude", patch: { status: "review" } });
    h.finishTurn();
    await flush();
    expect(h.task("t1")!.dispatchState).toBe("needs_input");
  });

  it("continues the SAME session when a turn ends without reaching review", async () => {
    const h = harness();
    // cap 3 → the 2nd turn is a NORMAL continuation (not yet last-chance), so
    // this test exercises the plain "continua sulla stessa sessione" path.
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchRetryCap: 3 });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    h.finishTurn(); // wall-clock timeout cuts the agent mid-work
    await flush();
    const t = h.task("t1")!;
    // NOT released back to todo: the conversation (and its worktree) survives,
    // the agent resumes where it was instead of re-planning from scratch.
    expect(t.status).toBe("in_progress");
    expect(t.assignedTopicId).toBe("topic-1");
    expect(t.dispatchAttempts).toBe(2); // the continuation costs an attempt
    expect(h.topicsCreated.length).toBe(1); // no fresh topic
    expect(h.turns.length).toBe(2);
    expect(h.turns[1].sessionKey).toBe("topic:topic-1"); // same tab resumed (prod sessionKey convention)
    expect(h.turns[1].content).toContain("interrotto");
    // Kickoff turn carries the FULL context envelope; the continuation is LEAN
    // (the persistent session already has CLAUDE.md/README/awareness — resending
    // them only compounds cache write/read).
    expect(h.turns[0].contextMode).toBe("full");
    expect(h.turns[1].contextMode).toBe("lean");
    // The thread explains what happened (visible history, not a silent retry).
    const comments = h.svc.get("t1")!.comments;
    expect(comments.some((c) => c.author === "system" && c.content.includes("stessa sessione"))).toBe(true);
  });

  it("parks in backlog when the retry budget is exhausted mid-continuation", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchRetryCap: 3 });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    h.finishTurn(); await flush(); // attempt 1 → continuation (attempt 2)
    h.finishTurn(); await flush(); // attempt 2 → continuation (attempt 3)
    h.finishTurn(); await flush(); // attempt 3 → cap: park
    const t = h.task("t1")!;
    expect(t.status).toBe("backlog");
    expect(t.dispatchState).toBe("failed"); // no agent output → genuine failure
    expect(t.assignedTopicId).toBeNull();
    expect(h.turns.length).toBe(3);
  });

  it("default retry cap is 2: parks after the 2nd turn, last-chance nudge on turn 2", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true }); // no cap → default 2
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    h.finishTurn(); await flush(); // attempt 1 → continuation (attempt 2 = cap)
    // The single continuation is already the LAST chance (deliver-what-you-have).
    expect(h.turns.length).toBe(2);
    expect(h.turns[1].content).toContain("ULTIMO TURNO");
    h.finishTurn(); await flush(); // attempt 2 at cap → park, no 3rd turn
    const t = h.task("t1")!;
    expect(t.status).toBe("backlog");
    expect(t.dispatchState).toBe("failed");
    expect(h.turns.length).toBe(2);
  });

  it("HANDS an exhausted-but-worked task to review instead of failing it", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    // The agent left a real comment trail (worked) but never moved to review.
    h.svc.addComment({ taskId: "t1", author: "agent", content: "Ecco il piano: 1) … 2) …" });
    h.finishTurn(); await flush(); // attempt 1 → continuation
    h.finishTurn(); await flush(); // attempt 2 → continuation
    h.finishTurn(); await flush(); // attempt 3 → exhausted, but agent spoke
    const t = h.task("t1")!;
    expect(t.status).toBe("review");            // handed to the human, NOT failed
    expect(t.dispatchState).toBe("needs_input");
    expect(t.assignedTopicId).not.toBeNull();   // binding kept: a reject resumes it
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
    expect(t.dispatchState).toBe("blocked");   // config issue (fixable), not a failure
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

  it("marks the session STANDALONE only for the catch-all path (project-less task), not a real project", async () => {
    // Catch-all: resolved path === catchAllProjectPath → standalone session.
    const catchAll = "/Users/x/.openclaw/workspace/generale";
    const h = harness({
      catchAllProjectPath: catchAll,
      resolveProject: () => ({ path: catchAll, projectStoreId: null }),
    });
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: false });
    seedTask(h.db, { id: "t1", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.topicsCreated[0].standalone).toBe(true);

    // A real project at a different path → NOT standalone (grouped as usual).
    const h2 = harness({
      catchAllProjectPath: catchAll,
      resolveProject: () => ({ path: "/Users/x/Projects/alpha", projectStoreId: null }),
    });
    h2.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: false });
    seedTask(h2.db, { id: "t1", status: "todo" });
    await h2.dispatcher.tick(PID);
    await flush();
    expect(h2.topicsCreated[0].standalone).toBeFalsy();
  });

  it("gives each catch-all task a PRIVATE per-task cwd (unique projectPath) but leaves a real project alone", async () => {
    const catchAll = "/Users/x/.openclaw/workspace/generale";
    const taskDir = (id: string) => `/Users/x/.openclaw/workspace/tasks/${id.slice(0, 8)}`;

    // Two catch-all tasks → two DISTINCT per-task dirs, both standalone.
    const h = harness({
      catchAllProjectPath: catchAll,
      catchAllTaskDir: taskDir,
      resolveProject: () => ({ path: catchAll, projectStoreId: null }),
    });
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: false, maxAgents: 5 });
    seedTask(h.db, { id: "aaaaaaaa-1", status: "todo" });
    seedTask(h.db, { id: "bbbbbbbb-2", status: "todo" });
    await h.dispatcher.tick(PID);
    await flush();
    const paths = h.topicsCreated.map((t) => t.projectPath).sort();
    expect(paths).toEqual([taskDir("aaaaaaaa-1"), taskDir("bbbbbbbb-2")].sort());
    expect(paths[0]).not.toBe(paths[1]);          // distinct workspaces
    expect(h.topicsCreated.every((t) => t.standalone)).toBe(true);
    expect(paths.every((p) => p !== catchAll)).toBe(true); // never the shared dir

    // A real project is NOT given a per-task dir — it runs in the project cwd.
    const h2 = harness({
      catchAllProjectPath: catchAll,
      catchAllTaskDir: taskDir,
      resolveProject: () => ({ path: "/Users/x/Projects/alpha", projectStoreId: "store-1" }),
    });
    h2.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: false });
    seedTask(h2.db, { id: "t1", status: "todo" });
    await h2.dispatcher.tick(PID);
    await flush();
    expect(h2.topicsCreated[0].projectPath).toBe("/Users/x/Projects/alpha");
    expect(h2.topicsCreated[0].standalone).toBeFalsy();
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

  it("reconcile requeues an orphaned (mid-dispatch) in-progress task, refunding the attempt", async () => {
    const h = harness();
    seedTask(h.db, { id: "t1", status: "in_progress", assignedTopicId: "topic-dead", attempts: 1, dispatchState: "working" });
    await h.dispatcher.reconcile();
    await flush();
    const t = h.task("t1")!;
    expect(t.status).toBe("todo");            // requeued
    expect(t.assignedTopicId).toBeNull();
    expect(t.dispatchAttempts).toBe(0);       // restart refunds the interrupted attempt
  });

  it("reconcile ALWAYS requeues a restart orphan (never parks): a restart is not a failure", async () => {
    // Even at the cap, a server restart must not park the task — it rolls the
    // interrupted attempt back and requeues, so deploys can't bounce a healthy
    // task into backlog "per errore".
    const h = harness();
    seedTask(h.db, { id: "t1", status: "in_progress", assignedTopicId: "topic-dead", attempts: 3, dispatchState: "working" });
    await h.dispatcher.reconcile();
    await flush();
    const t = h.task("t1")!;
    expect(t.status).toBe("todo");            // requeued, NOT parked
    expect(t.dispatchAttempts).toBe(2);       // 3 → 2 (refunded), gets a fair retry
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

  it("reconcile RESUMES a working restart-orphan on its own session (no requeue, no attempt burn)", async () => {
    // KANBAN-10: everything the turn needs survived the restart (topic, worktree,
    // CLI --resume conversation) — only the in-memory driver died. The orphan
    // must continue IN PLACE, never restart from zero on a fresh topic.
    const h = harness({ topicExists: () => true });
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "in_progress", assignedTopicId: "topic-live", attempts: 1, dispatchState: "working" });

    await h.dispatcher.reconcile();
    await flush();

    const t = h.task("t1")!;
    expect(t.status).toBe("in_progress");           // never bounced through todo
    expect(t.assignedTopicId).toBe("topic-live");   // SAME topic (same worktree, same conversation)
    expect(t.dispatchAttempts).toBe(1);             // a restart consumes nothing
    expect(t.dispatchState).toBe("working");
    expect(h.topicsCreated.length).toBe(0);         // no fresh topic spawned
    expect(h.turns.length).toBe(1);                 // one continuation turn on the SAME session
    expect(h.turns[0].sessionKey).toBe("topic:" + "topic-live".slice(0, 8));
    expect(h.turns[0].contextMode).toBe("lean");    // envelope already in the session history
    expect(h.turns[0].content).toContain("Riprendi da dove eri");
    const comments = h.svc.get("t1")!.comments;
    expect(comments.some((c) => c.author === "system" && c.content.includes("riprendo la stessa sessione"))).toBe(true);
  });

  it("reconcile REATTACHES in place (not resume) when a live broker session survived the restart", async () => {
    // ai-bridge: the turn kept running in the detached daemon → adopt it, don't
    // re-run. hasLiveSession true routes to reattach; NO continuation turn fires.
    const reattached: string[] = [];
    const h = harness({
      topicExists: () => true,
      hasLiveSession: async () => true,
      // Stay in-flight (like the harness runTurn) so onTurnEnd doesn't fire and
      // spawn a follow-up — we only assert the REATTACH branch was chosen.
      reattach: (sk: string) => { reattached.push(sk); return new Promise<void>(() => {}); },
    });
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "in_progress", assignedTopicId: "topic-live", attempts: 1, dispatchState: "working" });

    await h.dispatcher.reconcile();
    await flush();

    expect(reattached).toEqual(["topic:" + "topic-live".slice(0, 8)]); // adopted in place
    expect(h.turns.length).toBe(0);                 // NO resume/continuation turn
    expect(h.task("t1")!.dispatchAttempts).toBe(1); // a restart consumes nothing
    const comments = h.svc.get("t1")!.comments;
    expect(comments.some((c) => c.author === "system" && c.content.includes("Ripreso in diretta"))).toBe(true);
  });

  it("reconcile is idempotent under the poll: a resumed turn is never doubled", async () => {
    const h = harness({ topicExists: () => true });
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "in_progress", assignedTopicId: "topic-live", attempts: 1, dispatchState: "working" });

    await h.dispatcher.reconcile();
    await flush();
    await h.dispatcher.reconcile(); // the 10s poll fires while the resumed turn is still live
    await flush();

    expect(h.turns.length).toBe(1); // inFlight guard: no double-fire
    expect(h.dispatcher.isInFlight("t1")).toBe(true);
  });

  it("reconcile re-dispatches FRESH a working orphan whose topic died during the downtime", async () => {
    // No session left to resume → the requeue+re-claim path: rollback the
    // interrupted attempt, clear the dead binding, and (dispatch on) re-launch
    // from scratch on a brand-new topic.
    const h = harness({ topicExists: () => false });
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h.db, { id: "t1", status: "in_progress", assignedTopicId: "topic-dead", attempts: 1, dispatchState: "working" });

    await h.dispatcher.reconcile();
    await flush();

    const t = h.task("t1")!;
    expect(t.status).toBe("in_progress");
    expect(t.assignedTopicId).toBe("topic-1");                    // FRESH topic, not the dead one
    expect(t.dispatchAttempts).toBe(1);                            // rolled back to 0, re-claim bumped to 1
    expect(h.turns.length).toBe(1);
    expect(h.turns[0].content).toContain("owner esclusivo del task"); // kickoff da capo
  });

  it("reconcile with the global switch OFF requeues without resuming and without a stranded chip", async () => {
    // The human turned auto-dispatch off: no agent may relaunch. The orphan
    // goes back to todo, and the requeue's `queued` chip is cleared — on a
    // board that never dispatches it would strand forever.
    const h = harness({ topicExists: () => true });
    seedTask(h.db, { id: "t1", status: "in_progress", assignedTopicId: "topic-live", attempts: 2, dispatchState: "working" });

    await h.dispatcher.reconcile();
    await flush();

    const t = h.task("t1")!;
    expect(t.status).toBe("todo");
    expect(t.assignedTopicId).toBeNull();
    expect(t.dispatchAttempts).toBe(1);   // interrupted attempt refunded
    expect(t.dispatchState).toBeNull();   // no stranded 'queued'
    expect(h.turns.length).toBe(0);
  });

  it("reconcile requeues a starting orphan (kickoff may never have reached the CLI)", async () => {
    // Crash in the claim→bind window: there may be NO session to resume, so a
    // clean re-claim beats resuming into a possibly-empty conversation.
    const h = harness({ topicExists: () => true });
    seedTask(h.db, { id: "t1", status: "in_progress", assignedTopicId: null, attempts: 1, dispatchState: "starting" });

    await h.dispatcher.reconcile();
    await flush();

    const t = h.task("t1")!;
    expect(t.status).toBe("todo");        // auto off here → waits in todo
    expect(t.dispatchAttempts).toBe(0);   // refunded
    expect(h.turns.length).toBe(0);
  });

  it("reconcile resume at the retry cap delivers the last-chance nudge (a restart never parks)", async () => {
    const h = harness({ topicExists: () => true });
    h.svc.updateBoardSettings(PID, { autoDispatch: true }); // default retry cap = 2
    seedTask(h.db, { id: "t1", status: "in_progress", assignedTopicId: "topic-live", attempts: 2, dispatchState: "working" });

    await h.dispatcher.reconcile();
    await flush();

    const t = h.task("t1")!;
    expect(t.status).toBe("in_progress");     // resumed, not parked
    expect(t.dispatchAttempts).toBe(2);       // still no burn
    expect(h.turns.length).toBe(1);
    expect(h.turns[0].content).toContain("ULTIMO TURNO"); // budget exhausted → deliver-now nudge
  });

  it("launch parks (not requeues) when setup fails and attempts are exhausted", async () => {
    const h = harness({ createWorktree: async () => { throw new Error("git worktree add failed"); } });
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchRetryCap: 3 });
    seedTask(h.db, { id: "t1", status: "todo", attempts: 2 }); // claim bumps to 3 = cap
    await h.dispatcher.tick(PID);
    await flush();
    const t = h.task("t1")!;
    expect(t.status).toBe("backlog");   // parked, not stranded in todo
    expect(t.dispatchState).toBe("failed");
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
    expect(t.dispatchState).toBe("blocked");                // config issue, human must fix
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

  it("plan-first kickoff demands a plan in review BEFORE implementing", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    h.svc.create({ projectId: PID, text: "refactor grosso", status: "todo", planFirst: true });
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.turns[0].content).toContain("PLAN FIRST");
    expect(h.turns[0].content).toContain("Approva il piano");
    // A normal task never carries the plan contract.
    const h2 = harness();
    h2.svc.updateBoardSettings(PID, { autoDispatch: true });
    seedTask(h2.db, { id: "t1", status: "todo" });
    await h2.dispatcher.tick(PID);
    await flush();
    expect(h2.turns[0].content).not.toContain("PLAN FIRST");
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

describe("blocked-by + context reuse", () => {
  it("a blocked todo WAITS: no claim, no queued chip; onBlockerDone dispatches it", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    const a = h.svc.create({ projectId: PID, text: "blocker" });
    const b = h.svc.create({ projectId: PID, text: "dependent", blockedByTaskId: a.id });
    // Blocker parked out of the way (only b is an eligible todo).
    h.svc.update({ taskId: a.id, actor: "human", by: "u", patch: { status: "backlog" } });
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.task(b.id)!.status).toBe("todo");        // untouched, still waiting
    expect(h.task(b.id)!.dispatchState).toBeNull();    // no stranded "queued" chip
    expect(h.turns.length).toBe(0);
    // onEnterTodo on a blocked task is a no-op too (no chip, no grace timer).
    h.dispatcher.onEnterTodo(PID, b.id);
    expect(h.task(b.id)!.dispatchState).toBeNull();
    // Blocker completes → the nudge dispatches the dependent.
    h.svc.update({ taskId: a.id, actor: "human", by: "u", patch: { status: "done" } });
    h.dispatcher.onBlockerDone(a.id);
    await new Promise((r) => setTimeout(r, 30)); // grace (10ms in harness) + tick
    await flush();
    expect(h.task(b.id)!.status).toBe("in_progress");
    expect(h.turns.length).toBe(1);
  });

  it("reuseBlockerContext rides the blocker's topic (no fresh topic/worktree)", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    const a = h.svc.create({ projectId: PID, text: "blocker" });
    const b = h.svc.create({ projectId: PID, text: "dependent", blockedByTaskId: a.id, reuseBlockerContext: true });
    h.svc.update({ taskId: a.id, actor: "human", by: "u", patch: { status: "backlog" } });
    // The blocker worked in its own topic and was approved to done.
    h.db.run("INSERT OR IGNORE INTO topics (id) VALUES ('topic-blocker')");
    h.svc.bindTopic({ taskId: a.id, topicId: "topic-blocker" });
    h.svc.update({ taskId: a.id, actor: "human", by: "u", patch: { status: "done" } });
    await h.dispatcher.tick(PID);
    await flush();
    const t = h.task(b.id)!;
    expect(t.status).toBe("in_progress");
    expect(t.assignedTopicId).toBe("topic-blocker");   // SAME conversation
    expect(h.topicsCreated.length).toBe(0);             // no fresh topic
    expect(h.worktreesCreated.length).toBe(0);          // topic carries its own cwd
    expect(h.turns.length).toBe(1);
    expect(h.turns[0].sessionKey).toBe("topic:topic-bl"); // topic:<id8>
    expect(h.turns[0].content).toContain("STESSA sessione");
  });

  it("passes the task's model override to the fresh agent topic", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    h.svc.create({ projectId: PID, text: "with model", model: "claude-fable-5" });
    await h.dispatcher.tick(PID);
    await flush();
    expect((h.topicsCreated[0] as any).model).toBe("claude-fable-5");
  });

  it("auto model: calls the classifier and passes its pick to the fresh topic", async () => {
    const picked: string[] = [];
    const h = harness({
      pickAutoModel: async (t) => { picked.push(t.text); return { model: "claude-opus-4-8" }; },
    });
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    h.svc.create({ projectId: PID, text: "refactor pesante" }); // model null = auto
    await h.dispatcher.tick(PID);
    await flush();
    expect(picked).toEqual(["refactor pesante"]);
    expect((h.topicsCreated[0] as any).model).toBe("claude-opus-4-8");
  });

  it("auto model: an EXPLICIT model skips the classifier entirely", async () => {
    let called = false;
    const h = harness({
      pickAutoModel: async () => { called = true; return { model: "claude-opus-4-8" }; },
    });
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    h.svc.create({ projectId: PID, text: "chosen", model: "claude-haiku-4-5" });
    await h.dispatcher.tick(PID);
    await flush();
    expect(called).toBe(false);
    expect((h.topicsCreated[0] as any).model).toBe("claude-haiku-4-5");
  });

  it("auto model: a null pick keeps the provider default (undefined model, dispatch not blocked)", async () => {
    const h = harness({ pickAutoModel: async () => ({ model: null }) });
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    h.svc.create({ projectId: PID, text: "auto" });
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.task(h.svc.list({ scope: "project", projectId: PID })[0].id)!.status).toBe("in_progress");
    expect((h.topicsCreated[0] as any).model).toBeUndefined();
  });

  it("auto model: a vague task still selects a model but never flips plan-first (opt-in only)", async () => {
    const h = harness({ pickAutoModel: async () => ({ model: "claude-sonnet-5" }) });
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    const created = h.svc.create({ projectId: PID, text: "sistema la roba" }); // vague, model auto
    await h.dispatcher.tick(PID);
    await flush();
    const t = h.task(created.id)!;
    // The classifier's model is still applied…
    expect((h.topicsCreated[0] as any).model).toBe("claude-sonnet-5");
    // …and a vague task no longer forces plan-first: that's opt-in now.
    expect(t.planFirst).toBe(false);
    expect(h.turns[0].content).not.toContain("PLAN FIRST");
    const comments = h.svc.get(created.id)!.comments;
    expect(comments.some((c) => c.author === "system" && c.content.includes("plan-first"))).toBe(false);
  });

  it("auto model: an explicit model skips the classifier entirely (no auto plan-first)", async () => {
    // Explicit model → classifier never runs.
    let called = false;
    const h = harness({ pickAutoModel: async () => { called = true; return { model: "x" }; } });
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    const created = h.svc.create({ projectId: PID, text: "chiaro", model: "claude-haiku-4-5" });
    await h.dispatcher.tick(PID);
    await flush();
    expect(called).toBe(false);
    expect(h.task(created.id)!.planFirst).toBe(false);
  });
});

describe("priority", () => {
  it("serves the queue by priority (4 first), age as tie-break", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true, maxAgents: 1 });
    seedTask(h.db, { id: "old-low", status: "todo", createdAt: "2020-01-01T00:00:00.000Z" });
    const urgent = h.svc.create({ projectId: PID, text: "fuoco", priority: 4 });
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.task(urgent.id)!.status).toBe("in_progress"); // newer but urgent wins
    expect(h.task("old-low")!.status).toBe("todo");
  });

  it("kickoff asks the agent to set the priority ONLY when nobody chose one", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { autoDispatch: true, maxAgents: 2 });
    const auto = h.svc.create({ projectId: PID, text: "senza priorità" });
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.turns[0].content).toContain("Priorità automatica");
    h.finishTurn(); await flush();
    const h2 = harness();
    h2.svc.updateBoardSettings(PID, { autoDispatch: true });
    h2.svc.create({ projectId: PID, text: "scelta umana", priority: 3 });
    await h2.dispatcher.tick(PID);
    await flush();
    expect(h2.turns[0].content).not.toContain("Priorità automatica");
    expect(auto.priorityAuto).toBe(true);
  });
});
