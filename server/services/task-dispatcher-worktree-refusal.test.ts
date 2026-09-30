/**
 * A worktree the manager REFUSES to create is a permanent setup failure, not a
 * flaky one: the card parks as blocked with the refusal as its reason.
 *
 * WHY THIS TEST EXISTS. A registered project whose path has no `.git` makes
 * `createWorktree` throw `WorktreeRefusalError("Project path is not a git
 * repository: ...")`. The launch catch only recognised the routing errors, so
 * the refusal took the generic "flaky setup" branch: requeued with the generic
 * launch-failed reason, burned an attempt, and after the cap parked in backlog
 * with the same generic reason and the actual cause nowhere on the card. Seen in production on 30/09 (jevweb, two refusals in the server
 * error log, four manual backlog -> todo moves by a person who could not see why).
 *
 * The fence: a WorktreeOperationError (git itself failed) is still a flaky
 * setup and keeps the retry, only the manager's deliberate refusal parks.
 *
 * @covers KANBAN-10
 */
import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createTaskService, type TaskService } from "./tasks";
import { createTaskDispatcher, type DispatcherDeps } from "./task-dispatcher";
import { createTaskAttemptStore } from "./task-attempts";
import { WorktreeOperationError, WorktreeRefusalError } from "./worktree-manager";
import type { TurnEndInfo } from "../providers/stop-reason";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL } from "../db/test-schema";

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  db.run(`CREATE TABLE topics (id TEXT PRIMARY KEY)`);
  db.run(TASKS_DDL);
  db.run(TASKS_FK_STUBS_DDL);
  db.run(TASK_LABELS_DDL);
  db.run(`CREATE TABLE board_settings (
    project_id TEXT PRIMARY KEY, require_approval_for_done INTEGER DEFAULT 0,
    require_review_before_done INTEGER DEFAULT 0, block_status_with_pending INTEGER DEFAULT 0,
    only_lead_can_change_status INTEGER DEFAULT 0, max_agents INTEGER DEFAULT 5, auto_expire_hours INTEGER DEFAULT 24,
    auto_dispatch INTEGER NOT NULL DEFAULT 0, dispatch_effort TEXT NOT NULL DEFAULT 'medium', dispatch_model TEXT,
    dispatch_use_worktree INTEGER NOT NULL DEFAULT 1, dispatch_timeout_min INTEGER NOT NULL DEFAULT 20,
    dispatch_idle_min INTEGER NOT NULL DEFAULT 5,
    dispatch_mcp TEXT,
    dispatch_retry_cap INTEGER, dispatch_retry_backoff_s INTEGER,
    max_agents_auto INTEGER, dispatch_fanout INTEGER,
    dispatch_paused INTEGER NOT NULL DEFAULT 0,
    dispatch_topics_routing INTEGER CHECK (dispatch_topics_routing IN (0, 1))
  )`);
  db.run(`CREATE TABLE task_comments (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author TEXT NOT NULL DEFAULT 'user',
    content TEXT NOT NULL, mentions TEXT, media TEXT, created_at TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'comment', message_id TEXT
  )`);
  db.run(`CREATE TABLE approvals (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, requested_by TEXT NOT NULL,
    approval_type TEXT NOT NULL, from_status TEXT, to_status TEXT, confidence_score REAL,
    rubric_scores TEXT, justification TEXT, status TEXT NOT NULL DEFAULT 'pending',
    reviewed_by TEXT, review_comment TEXT, created_at TEXT NOT NULL, reviewed_at TEXT, expires_at TEXT
  )`);
  db.run(`CREATE TABLE task_attempts (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL, topic_id TEXT, worktree_id TEXT, branch TEXT, model TEXT,
    state TEXT NOT NULL DEFAULT 'running', commit_sha TEXT, files_changed INTEGER,
    insertions INTEGER, deletions INTEGER, summary TEXT, error TEXT,
    agent_ms INTEGER NOT NULL DEFAULT 0, agent_tokens INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, ended_at TEXT, selected_at TEXT,
    UNIQUE (task_id, idx)
  )`);
  return db;
}

const PID = "alpha-abc123";
const NOT_A_REPO = "Project path is not a git repository: /Users/x/Projects/alpha";

function seedTask(db: Database, id: string): void {
  const ts = new Date().toISOString();
  db.run(
    `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, dispatch_attempts)
     VALUES (?, ?, ?, 'todo', ?, ?, 0)`,
    [id, PID, "task " + id, ts, ts],
  );
}

function harness(createWorktree: DispatcherDeps["createWorktree"]) {
  const db = freshDb();
  const svc: TaskService = createTaskService(db);
  const turns: string[] = [];
  const topics: string[] = [];
  const deps: DispatcherDeps = {
    svc,
    attempts: createTaskAttemptStore(db),
    resolveProject: () => ({ path: "/Users/x/Projects/alpha", projectStoreId: "store-1" }),
    createTopic: (opts) => {
      topics.push(opts.name);
      const id = `topic-${topics.length}`;
      db.run("INSERT OR IGNORE INTO topics (id) VALUES (?)", [id]);
      return { topicId: id, sessionKey: `topic:${id}` };
    },
    createWorktree,
    deleteWorktree: async () => {},
    runTurn: async (sessionKey: string) => { turns.push(sessionKey); return undefined as TurnEndInfo | undefined; },
    broadcast: () => {},
    graceMs: 10,
    retryBackoffMs: 0,
    log: () => {},
  };
  return { db, svc, dispatcher: createTaskDispatcher(deps), turns, topics };
}

const flush = async (n = 40) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 5));
};

describe("a refused worktree parks the card with the refusal, it is not retried as flaky", () => {
  it("single agent: blocked on the first tick, the reason names the cause and the way out, no attempt burned", async () => {
    const h = harness(async () => { throw new WorktreeRefusalError(NOT_A_REPO); });
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: true, dispatchRetryCap: 2 });
    seedTask(h.db, "t1");

    await h.dispatcher.tick(PID);
    await flush();

    const task = h.svc.get("t1")!.task;
    expect(task.dispatchState).toBe("blocked");
    expect(task.dispatchError ?? "").toContain("not a git repository");
    expect(task.dispatchError ?? "").toContain("worktree isolato");
    // Parked, not back in the queue: a second tick must not try again.
    expect(task.status).not.toBe("todo");
    expect(task.dispatchAttempts).toBe(0);
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.svc.get("t1")!.task.dispatchState).toBe("blocked");
    expect(h.turns).toHaveLength(0);
    expect(h.topics).toHaveLength(0);
  });

  it("fan-out: the same refusal parks the card instead of closing N attempts as if they had run", async () => {
    const h = harness(async () => { throw new WorktreeRefusalError(NOT_A_REPO); });
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: true, dispatchFanOut: 2 });
    h.svc.setGlobalCap({ auto: false, max: 5 });
    seedTask(h.db, "t1");

    await h.dispatcher.tick(PID);
    await flush();

    const task = h.svc.get("t1")!.task;
    expect(task.dispatchState).toBe("blocked");
    expect(task.dispatchError ?? "").toContain("not a git repository");
    const rows = h.db.query("SELECT state FROM task_attempts WHERE task_id = 't1'").all() as { state: string }[];
    expect(rows.every((r) => r.state !== "running")).toBe(true);
    expect(h.turns).toHaveLength(0);
  });

  it("a git failure (WorktreeOperationError) is still a flaky setup: requeued, not blocked", async () => {
    const h = harness(async () => { throw new WorktreeOperationError("git worktree failed (exit 128)", "fatal: index.lock exists", 128); });
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: true, dispatchRetryCap: 3 });
    seedTask(h.db, "t1");

    await h.dispatcher.tick(PID);
    await flush();

    const task = h.svc.get("t1")!.task;
    expect(task.dispatchState).not.toBe("blocked");
    expect(task.status).toBe("todo");
  });
});
