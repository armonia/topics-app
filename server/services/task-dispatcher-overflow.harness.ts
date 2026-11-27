/**
 * The shared harness of the overflow tests (`task-dispatcher-overflow.test.ts`):
 * the node fake, the injected floor and the clock the test moves. Kept apart so
 * a new scenario can live in a sibling test file instead of growing that one
 * past its check:bloat ceiling (27/11/2026: 1891 lines against 1835).
 */
import { gitEnv } from "../../tests/setup/bun-test-preload";
import { expect } from "bun:test";
import { Database } from "bun:sqlite";
import { createTaskService, type TaskService } from "./tasks";
import { createTaskDispatcher, type DispatcherDeps } from "./task-dispatcher";
import type { ResourceFloorVerdict } from "./dispatch-capacity";
import type { NodeRunReport } from "./node-client";
import type { TurnEndInfo } from "../providers/stop-reason";
import type { OverflowMachine } from "./dispatch-overflow";
import type { LifecycleHookRunner } from "./lifecycle-hooks";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL } from "../db/test-schema";
import { NodeError } from "./node-client";
import { bundleBranch, plantCarriedBranch } from "./branch-on-origin";
import { resolveBranchBaseRef } from "./worktree-for-agent";
import { delegatedPolicyForTask } from "../lib/delegated-agent-start";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const PID = "alpha-abc123";
export const LOCAL = "questo-mac";
export const CLOUD = "cloud-claude";
export const PC = "pc-windows";
export const CARD = "card-ferma";

export const BLOCKED: ResourceFloorVerdict = {
  reason: "Memoria quasi finita: la lettura più bassa degli ultimi 2 minuti è 4.1 GB, sotto il pavimento di 6 GB.",
  kind: "memory",
  memoryFirstCardExempt: false,
};

/**
 * The delegated-start tables as the migration creates them (its `ALTER TABLE
 * tasks` lines are already in `TASKS_DDL`), plus the identity tables the policy
 * query joins: the delegated card of these tests holds a REAL policy, read by
 * the real `delegatedPolicyForTask`, not one built by hand.
 */
function delegationTables(db: Database): void {
  db.run("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)");
  db.run("CREATE TABLE people (id TEXT PRIMARY KEY, display_name TEXT, revoked_at INTEGER)");
  db.run("CREATE TABLE devices (id TEXT PRIMARY KEY, name TEXT, person_id TEXT, revoked_at INTEGER)");
  db.run("CREATE TABLE orgs (id TEXT PRIMARY KEY, revoked_at INTEGER)");
  db.run("CREATE TABLE org_members (org_id TEXT, person_id TEXT, revoked_at INTEGER, local_blocked_at INTEGER)");
  db.run("CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL)");
  const migration = readFileSync(join(import.meta.dir, "../db/migrations/20260912115225-delegated-agent-start.sql"), "utf8")
    .split("\n").filter((line) => !line.startsWith("ALTER TABLE tasks")).join("\n");
  db.exec(migration);
  db.run("INSERT INTO people VALUES ('owner', 'Owner', NULL), ('person-a', 'Guest', NULL)");
  db.run("INSERT INTO devices VALUES ('device-a', 'Guest device', 'person-a', NULL)");
}

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  // Before the stubs: the policy query reads the machine's name.
  db.run("CREATE TABLE machines (id TEXT PRIMARY KEY, name TEXT, base_url TEXT)");
  db.run(TASKS_DDL);
  delegationTables(db);
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
    max_agents_auto INTEGER, dispatch_fanout INTEGER,
    dispatch_overflow INTEGER NOT NULL DEFAULT 1, dispatch_stay_local INTEGER NOT NULL DEFAULT 0,
    dispatch_model TEXT, dispatch_paused INTEGER NOT NULL DEFAULT 0
  )`);
  db.run(`CREATE TABLE task_comments (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author TEXT NOT NULL DEFAULT 'user',
    content TEXT NOT NULL, mentions TEXT, media TEXT, created_at TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'comment',
    message_id TEXT
  )`);
  db.run(`CREATE TABLE approvals (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, requested_by TEXT NOT NULL,
    approval_type TEXT NOT NULL, from_status TEXT, to_status TEXT, confidence_score REAL,
    rubric_scores TEXT, justification TEXT, status TEXT NOT NULL DEFAULT 'pending',
    reviewed_by TEXT, review_comment TEXT, created_at TEXT NOT NULL, reviewed_at TEXT, expires_at TEXT
  )`);
  for (const id of [LOCAL, CLOUD, PC]) db.run("INSERT INTO machines (id) VALUES (?)", [id]);
  return db;
}

const ADDRESS: Record<string, string> = { [CLOUD]: "claude-cloud://", [PC]: "https://pc.local" };
const NAME: Record<string, string> = { [CLOUD]: "Cloud Claude", [PC]: "PC Windows" };

export function harness(opts: {
  cloudOnline?: boolean; pcOnline?: boolean; cloudCredit?: boolean; github?: boolean;
  /** The PC is offline but a `node-run` hook can wake it. */
  pcWakeable?: boolean;
  /** The PC's declared slots (0 = being drained). */
  pcSlots?: number;
  /** What `createRun` throws instead of answering (a cloud account without environments). */
  createRunError?: () => Error | null;
  /** What `readRun` throws instead of answering, while set (a live run's account refused). */
  readRunError?: { current: (() => Error) | null };
  /** The run report `readRun` answers instead of an idle run, given the card the run belongs to. */
  runReport?: (originTaskId: string) => Partial<NodeRunReport>;
  /** Leave `cloudCredit` to the real provider hold. */
  realCredit?: boolean;
  /** The Mac under its memory floor (default) or free. */
  floor?: boolean;
  /** The floor's verdict while it holds (default `BLOCKED`, a memory floor). */
  verdict?: ResourceFloorVerdict;
  /**
   * A node that cannot reach origin (the PC does not talk to GitHub): `repos.mac` holds the
   * card's branch, `repos.node` is the node's checkout. The node starts from what it holds.
   */
  noOrigin?: { mac: string; node: string; startedFrom: string[] };
  /** What pushing a card's own branch answers (default: it reaches origin). */
  ensure?: (branch: string) => { ok: true } | { ok: false; reason: string };
  /** The `node-run` hook that wakes the PC (default: the lane's own). */
  hooks?: LifecycleHookRunner;
} = {}) {
  const db = freshDb();
  const svc: TaskService = createTaskService(db);
  const created: Array<{ baseUrl: string; originTaskId: string }> = [];
  const bodies: Array<{ originTaskId: string; baseBranch?: string | null }> = [];
  const pushed: string[] = [];
  const worktrees: Array<{ baseBranch?: string } | undefined> = [];
  const turns: string[] = [];
  let now = Date.UTC(2026, 9, 30, 10, 0, 0);
  let nextRun = 0;
  const runCard = new Map<string, string>();
  const machines = (): OverflowMachine[] => [
    { id: CLOUD, name: NAME[CLOUD], kind: "cloud", online: opts.cloudOnline ?? true },
    { id: PC, name: NAME[PC], kind: "node", online: opts.pcOnline ?? true, wakeable: opts.pcWakeable ?? false, ...(opts.pcSlots !== undefined ? { slots: opts.pcSlots } : {}) },
  ];

  const deps: DispatcherDeps = {
    svc,
    resolveProject: () => ({ path: "/tmp/alpha", projectStoreId: "store-1" }),
    createTopic: () => {
      const id = `topic-${turns.length + 1}`;
      db.run("INSERT OR IGNORE INTO topics (id) VALUES (?)", [id]);
      return { topicId: id, sessionKey: `topic:${id}` };
    },
    createWorktree: async (_store, wopts) => { worktrees.push(wopts); return "wt-1"; },
    deleteWorktree: async () => {},
    runTurn: (sessionKey) => { turns.push(sessionKey); return new Promise<TurnEndInfo | void>(() => {}); },
    broadcast: () => {},
    // The Mac stays under its floor for the whole test: only a move gets the card out.
    resourceBlock: () => (opts.floor === false ? null : opts.verdict ?? BLOCKED),
    node: {
      createRun: async ({ baseUrl, body }) => {
        const startError = opts.createRunError?.();
        if (startError) throw startError;
        if (opts.noOrigin && body.baseBranch) {
          if (!body.branchBundle) throw new NodeError("branch_unreachable", "create run answered 409", 409);
          const planted = await plantCarriedBranch(opts.noOrigin.node, body.baseBranch, new Uint8Array(Buffer.from(body.branchBundle, "base64")));
          if (!planted.ok) throw new Error(planted.reason);
          const base = await resolveBranchBaseRef(opts.noOrigin.node, body.baseBranch);
          const tip = Bun.spawnSync(["git", "-C", opts.noOrigin.node, "rev-parse", base.baseRef], { env: gitEnv() }).stdout.toString().trim();
          opts.noOrigin.startedFrom.push(tip);
        }
        created.push({ baseUrl, originTaskId: body.originTaskId });
        bodies.push({ originTaskId: body.originTaskId, baseBranch: body.baseBranch });
        nextRun += 1;
        runCard.set(`run-${nextRun}`, body.originTaskId);
        return { runId: `run-${nextRun}` };
      },
      readRun: async ({ runId }) => {
        const fail = opts.readRunError?.current;
        if (fail) throw fail();
        return {
        status: "in_progress", dispatchState: "working", dispatchError: null, comments: [],
        deliveryBranch: null, deliveryCommit: null, baseSha: null, stat: null,
        ...opts.runReport?.(runCard.get(runId) ?? ""),
        };
      },
      fetchBundle: async () => ({ empty: true as const }),
      cancelRun: async () => {},
      baseUrlOf: (id) => ADDRESS[id] ?? null,
      tokenOf: () => "tok",
      nameOf: (id) => NAME[id] ?? null,
      localMachineId: () => LOCAL,
      originUrlOf: async () => "https://github.com/acme/alpha.git",
      plantBranch: async () => ({ planted: true, commit: "c0ffeec0ffee", commitCount: 1, reason: null }),
      bundleBranch: async ({ branch }) => (opts.noOrigin ? bundleBranch(opts.noOrigin.mac, branch) : null),
      ensureBranchOnOrigin: async ({ branch }) => { pushed.push(branch); return opts.ensure?.(branch) ?? { ok: true }; },
      ...(opts.hooks ? { hooks: opts.hooks } : {}),
    },
    overflowMachines: machines,
    githubOriginOf: async () => opts.github ?? true,
    ...(opts.realCredit ? {} : { cloudCredit: () => opts.cloudCredit ?? true }),
    // The real policy, read from the real tables (`delegationTables`).
    delegatedPolicyForTask: (taskId) => delegatedPolicyForTask(db, taskId, now, LOCAL),
    now: () => now,
    graceMs: 0,
    retryBackoffMs: 0,
    log: () => {},
  };
  const dispatcher = createTaskDispatcher(deps);
  svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: true, dispatchFanOut: 1 });
  svc.setGlobalCap({ auto: false, max: 9 });

  const seed = (id: string, extra: { machineId?: string | null; stayLocal?: boolean; deliveryBranch?: string; model?: string; costCents?: number; baseBranch?: string } = {}) => {
    const ts = new Date(now).toISOString();
    db.run(
      `INSERT INTO tasks (id, project_id, text, description, status, created_at, updated_at, dispatch_attempts, machine_id, stay_local,
                          delivery_branch, model, agent_cost_cents, base_branch)
       VALUES (?, ?, 'una card in coda', 'sotto il pavimento', 'todo', ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
      [id, PID, ts, ts, extra.machineId ?? null, extra.stayLocal ? 1 : 0, extra.deliveryBranch ?? null, extra.model ?? null, extra.costCents ?? 0, extra.baseBranch ?? null],
    );
  };
  /**
   * A card that was delivered on `branch` and then sent back to the queue by the
   * REAL transition (review -> todo through `svc.update`), not seeded in todo.
   */
  const sendBack = (id: string, branch: string, extra: { machineId?: string | null; landed?: boolean } = {}) => {
    seed(id, { machineId: extra.machineId ?? null });
    db.run("UPDATE tasks SET status = 'review', delivery_branch = ?, delivery_commit = 'abc1234', landing_state = ? WHERE id = ?",
      [branch, extra.landed ? "landed" : null, id]);
    svc.update({ taskId: id, actor: "human", by: "attilio", patch: { status: "todo" } });
    // The transition clears the delivery snapshot: what is left is the kept branch.
    expect(svc.get(id)!.task.deliveryBranch).toBeNull();
  };
  const flush = async (n = 12) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
  const tick = async () => { await dispatcher.tick(PID); await flush(); };
  const advance = (ms: number) => { now += ms; };
  const poll = async () => { await dispatcher.reconcile({ reason: "poll" }); await flush(); };
  return {
    db, svc, dispatcher, created, bodies, pushed, worktrees, turns, seed, sendBack, tick, poll, advance, now: () => now,
    task: (id: string) => svc.get(id)!.task, thread: (id: string) => svc.get(id)!.comments.map((c) => c.content).join("\n"),
  };
}

/**
 * NO MACHINE HAS ROOM: overrides `machineLoad`'s own read (`svc.countOnMachine`)
 * so `pickOverflowMachine` finds no free seat on `machineId`, without seeding
 * real filler cards - those would be live `in_progress` rows the dispatcher's
 * own remote-run reconciler tries to poll/relaunch, which is not what these
 * tests are about. Lets a test about what keeps a card HERE run without the
 * free-seat rule moving it elsewhere first.
 */
const machineFillOverrides = new WeakMap<TaskService, Map<string, number>>();
export function fillMachine(h: ReturnType<typeof harness>, machineId: string, n: number) {
  let overrides = machineFillOverrides.get(h.svc);
  if (!overrides) {
    overrides = new Map<string, number>();
    machineFillOverrides.set(h.svc, overrides);
    const real = h.svc.countOnMachine.bind(h.svc);
    h.svc.countOnMachine = (id: string) => overrides!.get(id) ?? real(id);
  }
  overrides.set(machineId, n);
}
/** Undoes `fillMachine`, freeing the machine's slots again. */
export function freeMachine(h: ReturnType<typeof harness>, machineId: string) {
  machineFillOverrides.get(h.svc)?.delete(machineId);
}

/**
 * Two rounds: the first one only starts this project's origin lookup
 * (`overflowOriginOf`), the second has the answer, which is the round the move
 * can happen in. The time in between is there only to make the wait visible:
 * no rule reads it any more.
 */
export async function settleTwoRounds(h: ReturnType<typeof harness>) {
  await h.tick();
  h.advance(5 * 60_000);
  await h.tick();
}
