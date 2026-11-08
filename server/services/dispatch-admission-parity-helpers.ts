/**
 * Shared fixtures for the admission parity and reservation lifecycle tests.
 */
import { setSystemTime } from "bun:test";
import { Database } from "bun:sqlite";
import { budgetShare, type MachineBudgetSample } from "../../shared/board";
import { createTaskService, type TaskService } from "./tasks";
import { createTaskDispatcher, type DispatcherDeps } from "./task-dispatcher";
import { createMemSignal } from "./mem-signal";
import { createDispatchResourceBlock } from "./dispatch-resource-block";
import type { TurnEndInfo } from "../providers/stop-reason";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL, APP_SETTINGS_DDL } from "../db/test-schema";
import { createTaskAttemptStore } from "./task-attempts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  db.run(`CREATE TABLE topics (id TEXT PRIMARY KEY)`);
  db.run(TASKS_DDL);
  db.run(TASKS_FK_STUBS_DDL);
  db.run(TASK_LABELS_DDL);
  db.run(readFileSync(join(import.meta.dir, "../db/migrations/20261025210852-task-no-local-check-reservations.sql"), "utf8"));
  db.run(`CREATE TABLE board_settings (
    project_id TEXT PRIMARY KEY, require_approval_for_done INTEGER DEFAULT 0,
    require_review_before_done INTEGER DEFAULT 0, block_status_with_pending INTEGER DEFAULT 0,
    only_lead_can_change_status INTEGER DEFAULT 0, max_agents INTEGER DEFAULT 5, auto_expire_hours INTEGER DEFAULT 24,
    auto_dispatch INTEGER NOT NULL DEFAULT 0, dispatch_effort TEXT NOT NULL DEFAULT 'medium',
    dispatch_use_worktree INTEGER NOT NULL DEFAULT 1, dispatch_timeout_min INTEGER NOT NULL DEFAULT 20,
    dispatch_idle_min INTEGER NOT NULL DEFAULT 5, dispatch_mcp TEXT,
    dispatch_retry_cap INTEGER, dispatch_retry_backoff_s INTEGER, review_checks TEXT,
    max_agents_auto INTEGER, dispatch_fanout INTEGER, dispatch_paused INTEGER NOT NULL DEFAULT 0,
    max_agents_mode TEXT, max_load_ratio REAL, max_mem_ratio REAL, machine_budget_share REAL
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
  db.run(APP_SETTINGS_DDL);
  db.run("UPDATE app_settings SET auto_dispatch = 1 WHERE id = 1");
  return db;
}

export const PID = "alpha-abc123";
let seq = 0;

export function seedTodo(db: Database, id: string, projectId = PID): void {
  const ts = new Date(Date.now() + ++seq).toISOString();
  db.run(
    `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, dispatch_attempts, priority)
     VALUES (?, ?, ?, 'todo', ?, ?, 0, 2)`,
    [id, projectId, "task " + id, ts, ts],
  );
}

export const SECOND_PID = "beta-def456";
export const THIRD_PID = "gamma-ghi789";

export function addLocalReviewCheck(svc: TaskService, projectId = PID): void {
  svc.updateBoardSettings(projectId, { reviewChecks: [{ name: "unit", cmd: "bun test" }] });
}

/** A card as the boot finds it: `in_progress` on a live topic, cut mid-turn. */
export function seedCutTurn(db: Database, id: string, projectId = PID): void {
  const ts = new Date(Date.now() + ++seq).toISOString();
  db.run("INSERT OR IGNORE INTO topics (id) VALUES (?)", [`topic-${id}`]);
  db.run(
    `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, dispatch_attempts, priority,
       dispatch_state, assigned_topic_id)
     VALUES (?, ?, ?, 'in_progress', ?, ?, 1, 2, 'working', ?)`,
    [id, projectId, "task " + id, ts, ts, `topic-${id}`],
  );
}

/** A quiet 12-core machine with plenty of memory: nothing here holds the gate. */
export const QUIET: MachineBudgetSample = {
  cores: 12, totalMemGB: 34, ourCoreUnits: 0.5, otherCoreUnits: 1,
  ourMemGB: 2, availableMemGB: 30, running: 0,
};

const dispatchers: { shutdown(): void }[] = [];
export function shutdownDispatchers(): void {
  for (const d of dispatchers.splice(0)) d.shutdown();
}

/** Turns never end, so a started turn stays in flight: `turns` counts starts. */
export function harness(overrides: Partial<DispatcherDeps> = {}) {
  const db = freshDb();
  const svc: TaskService = createTaskService(db);
  const startedAt: number[] = [];
  const turns: string[] = [];
  const prompts: string[] = [];
  const logLines: string[] = [];
  const machine: { sample: () => MachineBudgetSample | null } = { sample: () => ({ ...QUIET }) };
  const attempts = createTaskAttemptStore(db);
  const deps: DispatcherDeps = {
    svc,
    attempts,
    resolveProject: () => ({ path: "/Users/x/Projects/alpha", projectStoreId: "store-1" }),
    createTopic: () => {
      const n = startedAt.length + 1;
      startedAt.push(Date.now());
      db.run("INSERT OR IGNORE INTO topics (id) VALUES (?)", [`topic-${n}`]);
      return { topicId: `topic-${n}`, sessionKey: `topic:sk${n}` };
    },
    createWorktree: async (storeId) => `wt-${storeId}`,
    topicExists: () => true,
    runTurn: (sessionKey, content) => new Promise<TurnEndInfo | void>(() => { turns.push(sessionKey); prompts.push(content); }),
    broadcast: () => {},
    graceMs: 0,
    retryBackoffMs: 0,
    log: (m: string) => logLines.push(m),
    budgetSample: () => machine.sample(),
    ...overrides,
  };
  const dispatcher = createTaskDispatcher(deps);
  dispatchers.push(dispatcher);
  svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: false });
  return {
    db, svc, dispatcher, attempts, deps, startedAt, turns, prompts, logLines, machine,
    status: (taskId: string) => db.query<{ status: string }, [string]>("SELECT status FROM tasks WHERE id = ?").get(taskId)?.status,
    commentsFor: (taskId: string) => db.query<{ content: string }, [string]>("SELECT content FROM task_comments WHERE task_id = ?").all(taskId).map((row) => row.content),
    lines: (needle: string) => logLines.filter((l) => l.includes(needle)),
  };
}

export const flush = async (n = 12) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

export function sharedWindowHarness(mode: "resources" | "count", overrides: Partial<DispatcherDeps> = {}, swapUsedMB = 0, share = budgetShare({})) {
  let reading = 20;
  const signal = createMemSignal({
    measurable: true,
    probe: async () => ({ availGB: reading, swapins: 0, compressorPages: 0, pageSize: 16_384, swapUsedMB, swapTotalMB: 16_384, load1: 1 }),
  });
  const h = harness({
    agentMemSamples: () => [],
    agentCostSamples: () => [0.1],
    heldMemory: () => signal.held(),
    isCliRuntime: () => false,
    resourceBlock: createDispatchResourceBlock({
      worktreesPath: () => "/tmp",
      readFreeGB: () => 500,
      heldMemory: () => signal.held(),
      isCliRuntime: () => overrides.isCliRuntime?.() ?? false,
    }),
    ...overrides,
  });
  if (mode === "resources") h.svc.setGlobalCap({ mode: "resources", budgetShare: share });
  else h.svc.setGlobalCap({ auto: false, max: 4 });
  h.machine.sample = () => ({ ...QUIET, availableMemGB: signal.held().heldGB, running: h.startedAt.length });
  let t = Date.now();
  const beat = async (gb: number) => {
    setSystemTime(new Date(t));
    reading = gb;
    await signal.sample();
    await h.dispatcher.tick(PID);
    await flush();
    t += 10_000;
  };
  const beats = async (values: number[]) => { for (const gb of values) await beat(gb); };
  return { h, beat, beats };
}

export const repeatMemoryReading = (gb: number, n: number) => Array<number>(n).fill(gb);
