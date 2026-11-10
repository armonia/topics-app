/**
 * THE BENCH OF THE REMOTE LANE'S TESTS: a fake node, a fake clock, a task service
 * on an in-memory database. Shared by the files that test the lane, so none of
 * them has to copy it (a second copy would drift from the first).
 *
 * Moved out of `task-dispatcher-remote-node.test.ts` unchanged when a third group
 * of cases (the delivery that comes back from the node) would have grown that
 * file past its size ceiling.
 */
import { Database } from "bun:sqlite";
import { type LifecycleHookRunner } from "./lifecycle-hooks";
import { createTaskService, type TaskService } from "./tasks";
import { createTaskDispatcher, type DispatcherDeps } from "./task-dispatcher";
import type { NodeRunBinding, NodeRunReport } from "./node-client";
import type { DelegatedRunPolicy } from "../lib/delegated-agent-start";
import type { TurnEndInfo } from "../providers/stop-reason";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL } from "../db/test-schema";

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
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
    max_agents_auto INTEGER, dispatch_fanout INTEGER, language TEXT
  )`);
  db.run(`CREATE TABLE task_comments (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author TEXT NOT NULL DEFAULT 'user',
    content TEXT NOT NULL, mentions TEXT, media TEXT, created_at TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'comment',
    -- migration 20260904190855: l'ancora di KANBAN-72, qui è l'id del commento SUL NODO.
    message_id TEXT,
    -- migration 20260912081500: la nota quieta (la riga di consegna del nodo lo è).
    quiet INTEGER CHECK (quiet IN (0, 1))
  )`);
  db.run(`CREATE TABLE approvals (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, requested_by TEXT NOT NULL,
    approval_type TEXT NOT NULL, from_status TEXT, to_status TEXT, confidence_score REAL,
    rubric_scores TEXT, justification TEXT, status TEXT NOT NULL DEFAULT 'pending',
    reviewed_by TEXT, review_comment TEXT, created_at TEXT NOT NULL, reviewed_at TEXT, expires_at TEXT
  )`);
  db.run("INSERT INTO machines (id) VALUES ('node-1')");
  return db;
}

export const PID = "alpha-abc123";
export const TASK = "card-remota";
export const MACHINE = "node-1";
export const BASE_URL = "https://node.local";
export const TOKEN = "tok-node-1";

/** A node report carrying only the fields the case under test looks at. */
export function report(over: Partial<NodeRunReport> = {}): NodeRunReport {
  return {
    status: "in_progress",
    dispatchState: "working",
    dispatchError: null,
    comments: [],
    deliveryBranch: null,
    deliveryCommit: null,
    baseSha: null,
    stat: null,
    ...over,
  };
}

export interface NodeFakeOptions {
  /** `false` = never paired: neither address nor token. */
  paired?: boolean;
  createRun?: () => Promise<{ runId: string }>;
  readRun?: (runId: string) => Promise<NodeRunReport>;
  cancelRun?: (runId: string) => Promise<void>;
  bundle?: Uint8Array | null;
  planted?: { planted: boolean; commit: string | null; reason: string | null };
  /** The `node-run` hook runner; absent = the lane's own default. */
  hooks?: LifecycleHookRunner;
  projectPathOf?: (projectId: string) => string | null;
  /** The origin lookup; absent = an immediate answer. */
  originUrlOf?: () => Promise<string | null>;
}

export function nodeFake(o: NodeFakeOptions = {}) {
  const calls: string[] = [];
  const created: { body: unknown; token: string; delegation?: NodeRunBinding }[] = [];
  const plantedWith: { branch: string; baseSha: string | null; bundleBytes: number | null }[] = [];
  let nextRun = 0;
  const node: NonNullable<DispatcherDeps["node"]> = {
    createRun: async ({ body, token, delegation }) => {
      calls.push("create");
      created.push({ body, token, delegation });
      if (o.createRun) return o.createRun();
      nextRun += 1;
      return { runId: `run-${nextRun}` };
    },
    readRun: async ({ runId }) => {
      calls.push(`read:${runId}`);
      return o.readRun ? o.readRun(runId) : report();
    },
    fetchBundle: async () => {
      calls.push("bundle");
      return o.bundle && o.bundle.length > 0 ? { empty: false as const, bytes: o.bundle } : { empty: true as const };
    },
    cancelRun: async ({ runId }) => {
      calls.push(`cancel:${runId}`);
      if (o.cancelRun) await o.cancelRun(runId);
    },
    baseUrlOf: () => (o.paired === false ? null : BASE_URL),
    tokenOf: () => (o.paired === false ? null : TOKEN),
    delegatedTokenOf: () => (o.paired === false ? null : "tok-confined"),
    nameOf: () => "Portatile",
    localMachineId: () => "questa-macchina",
    originUrlOf: o.originUrlOf ?? (async () => "git@github.com:acme/alpha.git"),
    ...(o.hooks ? { hooks: o.hooks } : {}),
    ...(o.projectPathOf ? { projectPathOf: o.projectPathOf } : {}),
    plantBranch: async ({ branch, baseSha, bundle }) => {
      plantedWith.push({ branch, baseSha, bundleBytes: bundle ? bundle.length : null });
      return o.planted ?? { planted: true, commit: "c0ffeec0ffee", reason: null };
    },
  };
  return { node, calls, created, plantedWith };
}

export function delegatedPolicy(overrides: Partial<DelegatedRunPolicy> = {}): DelegatedRunPolicy {
  return {
    id: "capability-confined",
    subjectType: "person",
    subjectId: "person-confined",
    projectId: PID,
    machineId: MACHINE,
    machineName: "Portatile",
    repositoryKey: "github.com/acme/alpha",
    model: "gpt-5",
    effort: "medium",
    maxDurationMinutes: 7,
    maxAttempts: 1,
    fanout: 1,
    grantedByPersonId: "person-owner",
    grantedAt: Date.UTC(2026, 8, 6, 9, 0, 0),
    expiresAt: null,
    revokedAt: null,
    taskId: TASK,
    initiatorPersonId: "person-confined",
    initiatorDeviceId: "device-confined",
    ...overrides,
    deadlineAt: overrides.deadlineAt ?? null,
  };
}

export function harness(nodeOverrides: NodeFakeOptions = {}, depOverrides: Partial<DispatcherDeps> = {}) {
  const db = freshDb();
  const svc: TaskService = createTaskService(db);
  const fake = nodeFake(nodeOverrides);
  const worktrees: string[] = [];
  const topics: string[] = [];
  const turns: string[] = [];
  let now = Date.UTC(2026, 8, 6, 10, 0, 0);

  const deps: DispatcherDeps = {
    svc,
    resolveProject: () => ({ path: "/tmp/alpha", projectStoreId: "store-1" }),
    createTopic: () => {
      const id = `topic-${topics.length + 1}`;
      topics.push(id);
      db.run("INSERT OR IGNORE INTO topics (id) VALUES (?)", [id]);
      return { topicId: id, sessionKey: `topic:${id}` };
    },
    createWorktree: async () => { worktrees.push(`wt-${worktrees.length + 1}`); return `wt-${worktrees.length}`; },
    deleteWorktree: async () => {},
    runTurn: (sessionKey) => { turns.push(sessionKey); return Promise.resolve<TurnEndInfo | void>(undefined); },
    recordDelegatedPhase: () => {
      const policy = depOverrides.delegatedPolicyForTask?.(TASK);
      return policy?.deadlineAt ?? now + (policy?.maxDurationMinutes ?? 7) * 60_000;
    },
    broadcast: () => {},
    node: fake.node,
    now: () => now,
    graceMs: 0,
    retryBackoffMs: 0,
    log: () => {},
    ...depOverrides,
  };
  const dispatcher = createTaskDispatcher(deps);

  // `auto` said out loud: the global preference of whoever runs the suite must not reach the body.
  svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: true, dispatchFanOut: 1, language: "auto" });
  svc.setGlobalCap({ auto: false, max: 9 });

  return {
    db, svc, dispatcher, worktrees, topics, turns,
    calls: fake.calls, created: fake.created, plantedWith: fake.plantedWith,
    advance: (ms: number) => { now += ms; },
    nowMs: () => now,
    task: () => svc.get(TASK)!.task,
    comments: () => svc.get(TASK)!.comments,
    /** A todo that names the node: the only difference from any other card. */
    seed: (id: string = TASK) => {
      const ts = new Date(now).toISOString();
      db.run(
        `INSERT INTO tasks (id, project_id, text, description, status, created_at, updated_at, dispatch_attempts, machine_id)
         VALUES (?, ?, 'porta a casa la corsia remota', 'con il ramo', 'todo', ?, ?, 0, ?)`,
        [id, PID, ts, ts, MACHINE],
      );
    },
  };
}

export const flush = async (n = 12) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

/** One poll round: `reconcile` is what asks the node, once per slot. */
export async function poll(h: ReturnType<typeof harness>, rounds = 1) {
  for (let i = 0; i < rounds; i++) {
    await h.dispatcher.reconcile({ reason: "poll" });
    await flush();
  }
}

export async function dispatch(h: ReturnType<typeof harness>) {
  await h.dispatcher.tick(PID);
  await flush();
}

