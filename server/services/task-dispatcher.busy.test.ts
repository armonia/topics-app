/**
 * @covers CHAT-PERSIST-02
 * A resume that nobody awaits (the reconcile poll, the retry and slot timers,
 * a feedback queued during a turn) writes its first chip inside a try/finally
 * with no catch. A busy database there used to become an unhandled rejection,
 * which exits the server. `resumeInBackground` turns the busy refusal into a
 * warning. (A non-busy error stays a rejection, but `bun test` itself fails
 * the run on any unhandled rejection, so that half is not assertable here.)
 *
 * Reached through `reconcile`, the public door whose `void resumeInBackground(...)`
 * is the call under test: an orphaned `in_progress` card with a topic bound.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createTaskService, type TaskService } from "./tasks";
import { createTaskDispatcher, type DispatcherDeps, type TaskDispatcher } from "./task-dispatcher";
import { createTaskAttemptStore } from "./task-attempts";
import type { TurnEndInfo } from "../providers/stop-reason";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL } from "../db/test-schema";

const PID = "alpha-abc123";
const busy = () => Object.assign(new Error("database is locked"), { name: "SQLiteError", code: "SQLITE_BUSY", errno: 5 });

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
    auto_dispatch INTEGER NOT NULL DEFAULT 0, dispatch_effort TEXT NOT NULL DEFAULT 'medium',
    dispatch_use_worktree INTEGER NOT NULL DEFAULT 1, dispatch_timeout_min INTEGER NOT NULL DEFAULT 20,
    dispatch_mcp TEXT,
    dispatch_retry_cap INTEGER, dispatch_retry_backoff_s INTEGER,
    max_agents_auto INTEGER, dispatch_fanout INTEGER
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
    created_at TEXT NOT NULL, ended_at TEXT, selected_at TEXT, UNIQUE (task_id, idx)
  )`);
  return db;
}

/** A card as the boot finds it: `in_progress`, bound to a topic, chip `working`. */
function orphan(db: Database, id: string): void {
  const ts = new Date().toISOString();
  db.run("INSERT OR IGNORE INTO topics (id) VALUES (?)", [`topic-${id}`]);
  db.run(
    `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, dispatch_attempts, priority, dispatch_state, assigned_topic_id)
     VALUES (?, ?, 'orphan', 'in_progress', ?, ?, 1, 3, 'working', ?)`,
    [id, PID, ts, ts, `topic-${id}`],
  );
}

function harness() {
  const db = freshDb();
  const svc: TaskService = createTaskService(db);
  const warnings: string[] = [];
  const deps: DispatcherDeps = {
    svc,
    attempts: createTaskAttemptStore(db),
    resolveProject: () => ({ path: "/tmp/alpha", projectStoreId: "store-1" }),
    createTopic: () => ({ topicId: "topic-new", sessionKey: "topic:new" }),
    createWorktree: async () => "wt-1",
    topicExists: () => true,
    runTurn: () => new Promise<TurnEndInfo | void>(() => { /* stays in flight */ }),
    broadcast: () => {},
    graceMs: 0,
    retryBackoffMs: 0,
    log: (m: string) => { warnings.push(m); },
  };
  const dispatcher = createTaskDispatcher(deps);
  svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: false });
  // The first chip a resume writes is the one refused.
  svc.setDispatchState = () => { throw busy(); };
  return { db, dispatcher, warnings };
}

const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 10));
};

let rejections: unknown[] = [];
const onRejection = (reason: unknown) => { rejections.push(reason); };
let dispatcher: TaskDispatcher | null = null;

beforeEach(() => {
  rejections = [];
  process.on("unhandledRejection", onRejection);
});

afterEach(() => {
  process.off("unhandledRejection", onRejection);
  dispatcher?.shutdown();
  dispatcher = null;
});

describe("a resume nobody awaits, under a busy database", () => {
  it("a busy refusal of its first write is a warning, not an unhandled rejection", async () => {
    const h = harness();
    dispatcher = h.dispatcher;
    orphan(h.db, "t1");

    await h.dispatcher.reconcile();
    await flush();

    expect(rejections).toEqual([]);
    expect(h.warnings.some((m) => m.includes("resume of task t1") && m.includes("database busy"))).toBe(true);
  });
});
