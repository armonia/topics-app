/**
 * THE OVERFLOW: an eligible card prefers a free seat on another machine
 * BEFORE the Mac is even full, and - only when no machine has room at all -
 * falls back to the memory floor's own two-minute clock.
 *
 * The contract:
 *  1. A free seat anywhere (Cloud online with room, say) moves the card as
 *     soon as its origin answer is in - with NO two-minute wait, whether or
 *     not the Mac's floor holds it. Only when no machine has any room does
 *     the Mac's own memory floor, held past two minutes, decide instead;
 *  2. a card (or a board) marked "this Mac only" stays held, whatever the wait;
 *  3. Cloud offline (or without credit) and the PC online: the card goes to the PC;
 *  4. the board switch off: nothing moves;
 *  5. a card that already has a delivery branch starts FROM it over there: the
 *     branch is pushed first and rides `createRun` as `baseBranch`; a branch
 *     that cannot reach origin keeps the card here;
 *  6. Cloud only for a GitHub origin and a Claude model, otherwise the PC;
 *  7. the two-minute clock measures an UNBROKEN hold: a round in which another
 *     wait held the card, or a trip out of Todo, starts it again;
 *  8. a machine at its slots takes nothing more, and a round moves at most
 *     `OVERFLOW_MAX_PER_ROUND` cards.
 *
 * Harness: the node fake and the injected floor of
 * `task-dispatcher-remote-node-floor.test.ts`, with a clock the test moves.
 *
 * @covers KANBAN-76
 */
import { gitEnv } from "../../tests/setup/bun-test-preload";
import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { createTaskService, type TaskService } from "./tasks";
import { createTaskDispatcher, type DispatcherDeps } from "./task-dispatcher";
import type { ResourceFloorVerdict } from "./dispatch-capacity";
import { CLOUD_HOLD_KEY } from "../lib/cloud-weekly-limit";
import type { NodeRunReport } from "./node-client";
import { clearProviderHold, providerHold, resetProviderHoldStore } from "../lib/provider-hold";
import type { TurnEndInfo } from "../providers/stop-reason";
import {
  OVERFLOW_MAX_PER_ROUND, OVERFLOW_SLOTS, cloudRunsModel, overflowEligible, pickOverflowMachine,
  type OverflowChoice, type OverflowMachine,
} from "./dispatch-overflow";
import { CloudSetupError } from "../providers/claude-cloud/api";
import { NODE_DEAD_POLLS, NODE_SETUP_POLLS } from "./task-dispatcher-remote-node";
import { overflowNoteImmediate } from "./dispatch-overflow";
import { hangBreaker, wakeBreaker } from "./wake-breaker";
import type { LifecycleHookRunner } from "./lifecycle-hooks";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL } from "../db/test-schema";
import { NodeError } from "./node-client";
import { BRANCH_NOWHERE_REASON, bundleBranch, plantCarriedBranch } from "./branch-on-origin";
import { resolveBranchBaseRef } from "./worktree-for-agent";
import { delegatedPolicyForTask, putAgentStartCapability, queueDelegatedRun } from "../lib/delegated-agent-start";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PID = "alpha-abc123";
const LOCAL = "questo-mac";
const CLOUD = "cloud-claude";
const PC = "pc-windows";
const CARD = "card-ferma";

const BLOCKED: ResourceFloorVerdict = {
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

function harness(opts: {
  cloudOnline?: boolean; pcOnline?: boolean; cloudCredit?: boolean; github?: boolean;
  /** The PC is offline but a `node-run` hook can wake it. */
  pcWakeable?: boolean;
  /** The PC's declared slots (0 = being drained). */
  pcSlots?: number;
  /** What `createRun` throws instead of answering (a cloud account without environments). */
  createRunError?: () => Error | null;
  /** What `readRun` throws instead of answering, while set (a live run's account refused). */
  readRunError?: { current: (() => Error) | null };
  /** The run report `readRun` answers instead of an idle run. */
  runReport?: () => Partial<NodeRunReport>;
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
        return { runId: `run-${nextRun}` };
      },
      readRun: async () => {
        const fail = opts.readRunError?.current;
        if (fail) throw fail();
        return {
        status: "in_progress", dispatchState: "working", dispatchError: null, comments: [],
        deliveryBranch: null, deliveryCommit: null, baseSha: null, stat: null,
        ...opts.runReport?.(),
        };
      },
      fetchBundle: async () => ({ empty: true as const }),
      cancelRun: async () => {},
      baseUrlOf: (id) => ADDRESS[id] ?? null,
      tokenOf: () => "tok",
      nameOf: (id) => NAME[id] ?? null,
      localMachineId: () => LOCAL,
      originUrlOf: async () => "git@github.com:acme/alpha.git",
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
function fillMachine(h: ReturnType<typeof harness>, machineId: string, n: number) {
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
function freeMachine(h: ReturnType<typeof harness>, machineId: string) {
  machineFillOverrides.get(h.svc)?.delete(machineId);
}

/**
 * Two rounds: the first one only starts this project's origin lookup
 * (`overflowOriginOf`), the second has the answer, which is the round the move
 * can happen in. The time in between is there only to make the wait visible:
 * no rule reads it any more.
 */
async function settleTwoRounds(h: ReturnType<typeof harness>) {
  await h.tick();
  h.advance(5 * 60_000);
  await h.tick();
}

describe("overflow: la card prende un posto libero altrove appena ce n'è uno", () => {
  it("Mac sotto il pavimento, Cloud online e con un posto libero: la card parte lì SUBITO, senza nessuna attesa", async () => {
    const h = harness();
    h.seed(CARD);

    await h.tick();
    // The first round only started the origin lookup (`overflowOriginOf`'s
    // promise), so this card has nowhere to go yet.
    expect(h.task(CARD).machineId).toBeNull();
    await h.tick();
    // A free seat on the Cloud row beats the Mac's own floor: the card leaves
    // on the first round where the origin answer is in, with no wait at all.
    // Nothing else is left to try: when no machine has room the card simply
    // stays here (the case below).
    expect(h.task(CARD).machineId).toBe(CLOUD);
    expect(h.task(CARD).overflowedAt).toBeString();
    expect(h.created).toEqual([{ baseUrl: "claude-cloud://", originTaskId: CARD }]);
    expect(h.task(CARD).status).toBe("in_progress");
    expect(h.turns).toEqual([]);
    const note = h.svc.get(CARD)!.comments.map((c) => c.content).find((c) => c.startsWith("Spostata su"));
    expect(note).toStartWith("Spostata su Cloud Claude: c'era un posto libero lì.");
  });

  it("Mac sotto il pavimento ma NESSUNA macchina ha posto: la card resta ferma, quanto a lungo aspetti non conta", async () => {
    const h = harness();
    fillMachine(h, CLOUD, OVERFLOW_SLOTS.cloud);
    fillMachine(h, PC, OVERFLOW_SLOTS.node);
    h.seed(CARD);

    await h.tick();
    expect(h.task(CARD).machineId).toBeNull();
    expect(h.task(CARD).status).toBe("todo");
    h.advance(110_000);
    await h.tick();
    expect(h.task(CARD).machineId).toBeNull();
    expect(h.created).toEqual([]);

    // Still true with no room anywhere, however long the Mac's floor holds:
    // only a free seat (never checked here) moves the card.
    h.advance(10 * 60_000);
    await h.tick();
    expect(h.task(CARD).machineId).toBeNull();
    expect(h.created).toEqual([]);
  });

  it("anche la card con la macchina predefinita = questo Mac si sposta", async () => {
    const h = harness();
    h.seed(CARD, { machineId: LOCAL });
    await settleTwoRounds(h);
    expect(h.task(CARD).machineId).toBe(CLOUD);
  });

  it("una card marcata «solo Mac» resta ferma", async () => {
    const h = harness();
    h.seed(CARD, { stayLocal: true });
    await settleTwoRounds(h);
    h.advance(10 * 60_000);
    await h.tick();
    expect(h.task(CARD).machineId).toBeNull();
    expect(h.task(CARD).status).toBe("todo");
    expect(h.created).toEqual([]);
  });

  it("una card nata «solo Mac» (marcata alla creazione) resta ferma", async () => {
    const h = harness();
    const born = h.svc.create({ projectId: PID, text: "riavvia Jarvis", status: "todo", stayLocal: true });
    expect(born.stayLocal).toBe(true);
    await settleTwoRounds(h);
    expect(h.task(born.id).machineId).toBeNull();
    expect(h.created).toEqual([]);
  });

  it("una board marcata «solo Mac» tiene ferme le sue card", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { dispatchStayLocal: true });
    h.seed(CARD);
    await settleTwoRounds(h);
    expect(h.task(CARD).machineId).toBeNull();
    expect(h.created).toEqual([]);
  });

  it("con l'interruttore della board spento non si sposta niente", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { dispatchOverflow: false });
    h.seed(CARD);
    await settleTwoRounds(h);
    expect(h.task(CARD).machineId).toBeNull();
    expect(h.created).toEqual([]);
  });

  it("Cloud offline e PC online: la card va sul PC", async () => {
    const h = harness({ cloudOnline: false });
    h.seed(CARD);
    await settleTwoRounds(h);
    expect(h.task(CARD).machineId).toBe(PC);
    expect(h.created).toEqual([{ baseUrl: "https://pc.local", originTaskId: CARD }]);
  });

  // THE RULE, in one case: the Mac is under its memory floor, the PC has ONE
  // of its two seats free, and the card is on the PC on the round the origin
  // answer lands - no hold, no clock, no wait.
  it("Mac sotto il pavimento e il PC con UN solo posto libero: la card va sul PC", async () => {
    const h = harness({ cloudOnline: false });
    fillMachine(h, PC, OVERFLOW_SLOTS.node - 1);
    h.seed(CARD);
    await settleTwoRounds(h);
    expect(h.task(CARD).machineId).toBe(PC);
    expect(h.created).toEqual([{ baseUrl: "https://pc.local", originTaskId: CARD }]);
  });

  // The same card, with the Mac NOT holding anything (`floor: false`): there is
  // no hold to wait out any more, so the free seat wins here too.
  it("Mac che non trattiene niente e un posto libero sul PC: la card va lì lo stesso", async () => {
    const h = harness({ cloudOnline: false, floor: false });
    fillMachine(h, PC, OVERFLOW_SLOTS.node - 1);
    h.seed(CARD);
    await settleTwoRounds(h);
    expect(h.task(CARD).machineId).toBe(PC);
    expect(h.turns).toEqual([]);
  });

  it("Cloud senza credito e PC online: la card va sul PC", async () => {
    const h = harness({ cloudCredit: false });
    h.seed(CARD);
    await settleTwoRounds(h);
    expect(h.task(CARD).machineId).toBe(PC);
  });

  it("nessuna macchina online: la card resta in coda sul Mac", async () => {
    const h = harness({ cloudOnline: false, pcOnline: false });
    h.seed(CARD);
    await settleTwoRounds(h);
    expect(h.task(CARD).machineId).toBeNull();
    expect(h.task(CARD).status).toBe("todo");
  });

  it("una card assegnata a mano a una macchina offline che non si può accendere torna qui", async () => {
    const h = harness({ pcOnline: false });
    h.seed(CARD, { machineId: PC });
    await settleTwoRounds(h);
    expect(h.task(CARD).machineId).not.toBe(PC);
  });
});

/**
 * THE REAL INCIDENT (13/11, PR #904's review): the first card dispatched for a
 * project after a restart hit the cold origin cache, read as "no origin", on
 * the SAME tick the Mac itself had room (`floor: false`) - so it started
 * locally there and then, grabbing the Mac's seat, even with a node sitting
 * free the whole time. The fix must not need the floor to be holding anything:
 * a free node beats the Mac on the very first tick too.
 */
describe("overflow: la cache fredda dell'origin non lascia partire la card sul Mac", () => {
  it("Mac libero (floor:false) e un nodo con un posto: la prima card non parte sul Mac mentre l'origin è ancora da chiedere", async () => {
    const h = harness({ floor: false });
    h.seed(CARD);
    await h.tick();
    // The origin lookup for this project just started: nowhere decided yet,
    // but crucially NOT on the Mac either, even though the Mac has room.
    expect(h.task(CARD).machineId).toBeNull();
    expect(h.turns).toEqual([]);
    await h.tick();
    // The answer is in: the free node wins over the Mac that was never full.
    expect(h.task(CARD).machineId).toBe(CLOUD);
  });

  it("stesso caso ma nessuna macchina ha posto: la prima card parte sul Mac, non aspetta un origin che non le serve", async () => {
    const h = harness({ floor: false });
    fillMachine(h, CLOUD, OVERFLOW_SLOTS.cloud);
    fillMachine(h, PC, OVERFLOW_SLOTS.node);
    h.seed(CARD);
    await h.tick();
    expect(h.task(CARD).machineId).toBeNull();
    expect(h.turns).toEqual([`topic:topic-1`]);
  });
});

describe("overflow: slots 0 svuota la macchina", () => {
  it("con slots 0 il PC non riceve card per overflow", async () => {
    const h = harness({ cloudOnline: false, pcSlots: 0 });
    h.seed(CARD);
    await settleTwoRounds(h);
    expect(h.task(CARD).machineId).toBeNull();
    expect(h.created).toEqual([]);
  });

  it("con slots 0 una card fissata sul PC non parte lì: viene riassegnata", async () => {
    const h = harness({ floor: false, pcSlots: 0 });
    h.seed(CARD, { machineId: PC });
    await settleTwoRounds(h);
    expect(h.task(CARD).machineId).not.toBe(PC);
    expect(h.created).toEqual([{ baseUrl: "claude-cloud://", originTaskId: CARD }]);
  });

  it("con slots 2 le riceve, fissate comprese", async () => {
    const h = harness({ cloudOnline: false, pcSlots: 2 });
    h.seed(CARD);
    await settleTwoRounds(h);
    expect(h.task(CARD).machineId).toBe(PC);
    const pinned = harness({ floor: false, pcSlots: 2 });
    pinned.seed(CARD, { machineId: PC });
    await settleTwoRounds(pinned);
    expect(pinned.created.length).toBe(1);
  });
});

describe("a card pinned to a machine at its seats", () => {
  function runningOverride(h: ReturnType<typeof harness>, n: number) {
    h.svc.countRunningOnMachine = () => n;
  }
  it("stays in todo, no attempt spent, nothing sent to the node", async () => {
    const h = harness({ floor: false, pcSlots: 2 });
    h.seed(CARD, { machineId: PC });
    runningOverride(h, 2);
    await settleTwoRounds(h);
    expect(h.task(CARD).status).toBe("todo");
    expect(h.task(CARD).dispatchAttempts ?? 0).toBe(0);
    expect(h.created).toEqual([]);
  });
  it("starts as soon as a seat is free", async () => {
    const h = harness({ floor: false, pcSlots: 2 });
    h.seed(CARD, { machineId: PC });
    runningOverride(h, 1);
    await settleTwoRounds(h);
    expect(h.created.length).toBe(1);
  });
});

describe("overflow: il ramo della card, l'origin, il modello", () => {
  it("sul Mac la card con un ramo base fa nascere il worktree da lì, non da main", async () => {
    const h = harness({ floor: false });
    // Not what this test is about: with overflow on, a cold origin cache
    // defers both cards one round (see the cold-cache describe below) before
    // either reaches a worktree at all. Off, they start locally at once.
    h.svc.updateBoardSettings(PID, { dispatchOverflow: false });
    h.seed("specchio", { baseBranch: "topics/endless-calf" });
    h.seed("altra");
    await h.tick();
    expect(h.worktrees).toContainEqual({ baseBranch: "topics/endless-calf" });
    expect(h.worktrees).toContainEqual(undefined);
  });

  it("una card con un ramo di consegna va su Cloud partendo DA quel ramo, pushato prima", async () => {
    const h = harness();
    h.seed(CARD, { deliveryBranch: "topics/endless-calf" });
    await settleTwoRounds(h);
    // The push answers asynchronously: the move comes in the next round.
    await h.tick();
    expect(h.task(CARD).machineId).toBe(CLOUD);
    expect(h.pushed).toContain("topics/endless-calf");
    expect(h.bodies).toEqual([{ originTaskId: CARD, baseBranch: "topics/endless-calf" }]);
  });

  it("una card senza ramo parte dal default: nessun baseBranch, nessun push", async () => {
    const h = harness();
    h.seed(CARD);
    await settleTwoRounds(h);
    expect(h.bodies).toEqual([{ originTaskId: CARD, baseBranch: undefined }]);
    expect(h.pushed).toEqual([]);
  });

  it("un ramo che non arriva su origin tiene la card sul Mac", async () => {
    const h = harness({ ensure: () => ({ ok: false, reason: "push rifiutato: non-fast-forward" }) });
    h.seed(CARD, { deliveryBranch: "topics/endless-calf" });
    await settleTwoRounds(h);
    for (let i = 0; i < 3; i++) { h.advance(70_000); await h.tick(); }
    expect(h.task(CARD).machineId).toBeNull();
    expect(h.task(CARD).status).toBe("todo");
    expect(h.created).toEqual([]);
  });

  it("un delivery_branch fantasma (né qui né su origin) non tiene ferma la card: ripiega su prior_branch", async () => {
    const h = harness({ ensure: (branch) => (branch === "topics/imperial-castle" ? { ok: false, reason: BRANCH_NOWHERE_REASON } : { ok: true }) });
    h.seed(CARD, { deliveryBranch: "topics/imperial-castle" });
    h.db.run("UPDATE tasks SET prior_branch = 'topics/stealthy-bog' WHERE id = ?", [CARD]);
    await settleTwoRounds(h);
    // One round to learn the branch is a phantom, one to push the fallback, one to move.
    for (let i = 0; i < 3; i++) await h.tick();
    expect(h.pushed).toContain("topics/stealthy-bog");
    expect(h.task(CARD).machineId).not.toBeNull();
  });

  it("un delivery_branch fantasma senza alternative: la card non resta ferma per sempre", async () => {
    const h = harness({ ensure: () => ({ ok: false, reason: BRANCH_NOWHERE_REASON }) });
    h.seed(CARD, { deliveryBranch: "topics/imperial-castle" });
    await settleTwoRounds(h);
    for (let i = 0; i < 3; i++) await h.tick();
    expect(h.task(CARD).machineId).not.toBeNull();
  });

  it("anche una card mandata a mano sul PC parte dal suo ramo; se non si può pushare, si ferma con il motivo", async () => {
    const h = harness();
    h.seed("a-mano", { machineId: PC, deliveryBranch: "topics/endless-calf" });
    await h.tick();
    expect(h.bodies).toEqual([{ originTaskId: "a-mano", baseBranch: "topics/endless-calf" }]);

    const k = harness({ ensure: () => ({ ok: false, reason: "push rifiutato" }) });
    k.seed("a-mano", { machineId: PC, deliveryBranch: "topics/endless-calf" });
    await k.tick();
    expect(k.created).toEqual([]);
    expect(k.task("a-mano").status).not.toBe("in_progress");
    expect(k.svc.get("a-mano")!.comments.map((c) => c.content).join("\n")).toContain("topics/endless-calf");
  });

  it("origin non su GitHub: il Cloud rifiuterebbe, la card va sul PC", async () => {
    const h = harness({ github: false });
    h.seed(CARD);
    await settleTwoRounds(h);
    expect(h.task(CARD).machineId).toBe(PC);
  });

  it("modello non Claude (Codex): niente Cloud, la card va sul PC", async () => {
    const h = harness();
    h.seed(CARD, { model: "codex:gpt-5.5" });
    await settleTwoRounds(h);
    expect(h.task(CARD).machineId).toBe(PC);
  });

  it("modello non Claude e PC offline: resta sul Mac", async () => {
    const h = harness({ pcOnline: false });
    h.seed(CARD, { model: "codex:gpt-5.5" });
    await settleTwoRounds(h);
    expect(h.task(CARD).machineId).toBeNull();
  });
});

describe("overflow: una card rimandata in coda dopo la review porta il suo ramo", () => {
  it("review -> todo vero, poi l'overflow su Cloud: il nodo riceve quel ramo come base", async () => {
    const h = harness();
    h.sendBack(CARD, "topics/endless-calf");
    expect(h.task(CARD).priorBranch).toBe("topics/endless-calf");
    await settleTwoRounds(h);
    await h.tick();
    expect(h.task(CARD).machineId).toBe(CLOUD);
    expect(h.pushed).toContain("topics/endless-calf");
    expect(h.bodies).toEqual([{ originTaskId: CARD, baseBranch: "topics/endless-calf" }]);
  });

  it("review -> todo vero con la macchina scelta a mano: stesso ramo come base", async () => {
    const h = harness({ floor: false });
    h.sendBack(CARD, "topics/endless-calf", { machineId: PC });
    await h.tick();
    expect(h.bodies).toEqual([{ originTaskId: CARD, baseBranch: "topics/endless-calf" }]);
  });

  it("un rifiuto in review conserva il ramo, e la card mandata poi sul PC parte da lì", async () => {
    const h = harness({ floor: false });
    h.seed(CARD);
    h.db.run("UPDATE tasks SET status = 'review', delivery_branch = 'topics/endless-calf', delivery_commit = 'abc1234' WHERE id = ?", [CARD]);
    h.svc.reviewDecision({ taskId: CARD, by: "attilio", decision: "reject", comment: "manca un test" });
    expect(h.task(CARD).deliveryBranch).toBeNull();
    expect(h.task(CARD).priorBranch).toBe("topics/endless-calf");
    h.db.run("UPDATE tasks SET status = 'todo', machine_id = ? WHERE id = ?", [PC, CARD]);
    await h.tick();
    expect(h.bodies).toEqual([{ originTaskId: CARD, baseBranch: "topics/endless-calf" }]);
  });

  it("three rejected deliveries keep every delivery branch, not only the last", () => {
    const h = harness({ floor: false });
    h.seed(CARD);
    for (const branch of ["topics/del-a", "topics/del-b"]) {
      h.db.run("UPDATE tasks SET status = 'review', delivery_branch = ?, delivery_commit = 'abc1234' WHERE id = ?", [branch, CARD]);
      h.svc.reviewDecision({ taskId: CARD, by: "reviewer", decision: "reject", comment: "again" });
    }
    expect(h.task(CARD).priorBranch).toBe("topics/del-b");
    expect(h.task(CARD).pastDeliveryBranches).toEqual(["topics/del-a", "topics/del-b"]);
  });

  it("un ramo già atterrato su main non fa da base: main è più nuovo", async () => {
    const h = harness({ floor: false });
    h.sendBack(CARD, "topics/endless-calf", { machineId: PC, landed: true });
    expect(h.task(CARD).priorBranch).toBeUndefined();
    await h.tick();
    expect(h.bodies).toEqual([{ originTaskId: CARD, baseBranch: undefined }]);
  });
});

describe("a node that cannot reach origin: the carried branch rides with the run", () => {
  const git = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", cwd, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.toString().trim();
  };
  const repos = () => {
    const root = mkdtempSync(join(tmpdir(), "no-origin-"));
    const mac = join(root, "mac");
    const node = join(root, "node");
    git(root, "init", "-q", "-b", "main", mac);
    writeFileSync(join(mac, "a.txt"), "base\n");
    git(mac, "add", ".");
    git(mac, "commit", "-q", "-m", "base");
    git(root, "clone", "-q", mac, node);
    // The node cannot reach origin: without a remote the fetch fallback is gone, so only the bundle can carry the branch.
    git(node, "remote", "remove", "origin");
    git(mac, "switch", "-q", "-c", "topics/endless-calf");
    for (const f of ["b", "c", "d"]) {
      writeFileSync(join(mac, `${f}.txt`), `${f}\n`);
      git(mac, "add", ".");
      git(mac, "commit", "-q", "-m", f);
    }
    return { root, mac, node, tip: git(mac, "rev-parse", "HEAD") };
  };

  it("origin unreachable from the node: the run starts from the branch commit, shipped as a bundle", async () => {
    const r = repos();
    try {
      const startedFrom: string[] = [];
      const h = harness({ floor: false, noOrigin: { mac: r.mac, node: r.node, startedFrom } });
      h.sendBack(CARD, "topics/endless-calf", { machineId: PC });
      await h.tick();
      // The launch is not awaited by the tick and real git takes a moment.
      for (let i = 0; i < 100 && startedFrom.length === 0; i++) await new Promise((res) => setTimeout(res, 50));
      expect(startedFrom).toEqual([r.tip]);
      expect(h.bodies).toHaveLength(1);
    } finally {
      rmSync(r.root, { recursive: true, force: true });
    }
  });
});

describe("overflow: il modello predefinito della board", () => {
  it("board con dispatchModel Codex e card senza modello: niente Cloud, va sul PC", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { dispatchModel: "codex:gpt-5.5" });
    h.seed(CARD);
    await settleTwoRounds(h);
    expect(h.task(CARD).machineId).toBe(PC);
  });

  it("board con dispatchModel Claude: Cloud", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { dispatchModel: "claude-code:sonnet" });
    h.seed(CARD);
    await settleTwoRounds(h);
    expect(h.task(CARD).machineId).toBe(CLOUD);
  });
});

describe("overflow: il PC addormentato", () => {
  it("senza Cloud e con il PC addormentato ma svegliabile: la card va sul PC", async () => {
    const h = harness({ cloudCredit: false, pcOnline: false, pcWakeable: true });
    h.seed(CARD);
    await settleTwoRounds(h);
    expect(h.task(CARD).machineId).toBe(PC);
    expect(h.created).toEqual([{ baseUrl: "https://pc.local", originTaskId: CARD }]);
  });

  it("un PC offline senza nulla che lo svegli resta escluso", async () => {
    const h = harness({ cloudCredit: false, pcOnline: false, pcWakeable: false });
    h.seed(CARD);
    await settleTwoRounds(h);
    expect(h.task(CARD).machineId).toBeNull();
  });

  // 21/11: a PC that accepted runs and answered no poll still got cards moved onto it, which then
  // waited there for hours while other machines had free seats. The hang breaker keeps new ones away.
  it("un PC svegliabile ma appeso (due corse sepolte di fila) non riceve card nuove", async () => {
    hangBreaker.failure(PC);
    hangBreaker.failure(PC);
    try {
      const h = harness({ cloudCredit: false, pcOnline: false, pcWakeable: true });
      h.seed(CARD);
      await settleTwoRounds(h);
      expect(h.task(CARD).machineId).toBeNull();
      expect(h.created).toEqual([]);
    } finally {
      hangBreaker.success(PC);
    }
  });

  it("una card già legata al PC appeso torna libera invece di aspettarlo", async () => {
    hangBreaker.failure(PC);
    hangBreaker.failure(PC);
    try {
      const h = harness({ cloudCredit: false, pcOnline: false, pcWakeable: true });
      h.seed(CARD, { machineId: PC });
      await settleTwoRounds(h);
      expect(h.task(CARD).machineId).not.toBe(PC);
      expect(h.created).toEqual([]);
    } finally {
      hangBreaker.success(PC);
    }
  });
});

/** Both breakers are module state: a test that touches them clears both machines (its last tick may launch on the other one). */
const clearBreakers = () => { for (const id of [CLOUD, PC]) { wakeBreaker.success(id); hangBreaker.success(id); } };
/** The overflow's moves onto `machineId` from now on: the thread cannot count them, it merges a note repeated within minutes. */
function countMovesTo(h: ReturnType<typeof harness>, machineId: string): () => number {
  const real = h.svc.overflowToMachine.bind(h.svc);
  let n = 0;
  h.svc.overflowToMachine = (args) => { if (args.machineId === machineId) n += 1; return real(args); };
  return () => n;
}

// 21/11: the breaker opened on the PC, and the card the overflow had put there was deferred
// with its pin until the breaker closed, then went back to the same PC. The system's move is
// undone at once, and the overflow never picks a blocked machine, the CLOUD included: picked
// anyway, the card came back to it every tick for the whole window. A person's pin waits.
describe("il nodo o il Cloud che non si sveglia: la card spostata dal sistema lo lascia e non ci torna, quella fissata a mano lo aspetta", () => {
  const veto: LifecycleHookRunner = { run: async () => ({ ok: false, reason: "il PC non si sveglia" }) };

  it("spostata dall'overflow, due sveglie fallite: perde il PC senza rinvio, con una nota sola, e il giro dopo va altrove", async () => {
    const o = { cloudCredit: false, hooks: veto };
    const h = harness(o);
    try {
      h.seed(CARD);
      await settleTwoRounds(h);
      expect(h.task(CARD)).toMatchObject({ machineId: PC, overflowedAt: expect.any(String) });
      // First veto: below the threshold, the card waits for the PC as before. The second opens the breaker.
      expireWait(h);
      await h.tick();
      expect(h.task(CARD)).toMatchObject({ status: "todo", machineId: null, dispatchDeferredUntil: null });
      expect(h.thread(CARD).match(/Tolta dal nodo bloccato: il nodo «PC Windows» non è pronto/g)).toHaveLength(1);
      expect(h.thread(CARD)).not.toContain("non gli mando altre card");
      o.cloudCredit = true;
      await h.tick();
      expect(h.task(CARD).machineId).toBe(CLOUD);
    } finally { clearBreakers(); }
  });

  it("spostata sul Cloud, due sveglie fallite e nessun'altra macchina: torna qui e il Cloud non la riprende a ogni giro", async () => {
    const h = harness({ pcOnline: false, hooks: veto });
    try {
      h.seed(CARD);
      await settleTwoRounds(h);
      expireWait(h);
      await h.tick();
      expect(h.task(CARD)).toMatchObject({ status: "todo", machineId: null, dispatchDeferredUntil: null });
      expect(h.thread(CARD).match(/Tolta dal nodo bloccato: il nodo «Cloud Claude» non è pronto/g)).toHaveLength(1);
      const movesToCloud = countMovesTo(h, CLOUD);
      for (let i = 0; i < 5; i++) { h.advance(10_000); await h.tick(); }
      expect(movesToCloud()).toBe(0);
      expect(h.task(CARD)).toMatchObject({ status: "todo", machineId: null });
    } finally { clearBreakers(); }
  });

  it("spostata sul Cloud appeso (due corse sepolte di fila): va sul PC libero, mai di nuovo sul Cloud", async () => {
    const h = harness();
    hangBreaker.failure(CLOUD);
    hangBreaker.failure(CLOUD);
    try {
      h.seed(CARD, { machineId: CLOUD });
      h.db.run("UPDATE tasks SET overflowed_at = ? WHERE id = ?", [new Date(h.now()).toISOString(), CARD]);
      for (let i = 0; i < 6; i++) { await h.tick(); h.advance(10_000); }
      expect(h.task(CARD).machineId).toBe(PC);
      expect(h.created).toEqual([{ baseUrl: "https://pc.local", originTaskId: CARD }]);
      expect(h.thread(CARD)).not.toContain("Spostata su Cloud Claude");
    } finally { clearBreakers(); }
  });

  it("fissata a mano sul PC o sul Cloud, due sveglie fallite: resta lì e aspetta che il freno si chiuda", async () => {
    for (const machine of [PC, CLOUD]) {
      const h = harness({ cloudCredit: false, hooks: veto });
      try {
        h.seed(CARD, { machineId: machine });
        await h.tick();
        expireWait(h);
        await h.tick();
        const t = h.task(CARD);
        expect(t).toMatchObject({ status: "todo", machineId: machine });
        expect(Date.parse(t.dispatchDeferredUntil!) - Date.now()).toBeGreaterThan(10 * 60_000);
      } finally { clearBreakers(); }
    }
  });
});

/**
 * The node retry wait is over. The service writes `dispatch_deferred_until` with
 * the wall clock, not the harness one, so the wait is ended the way time would.
 */
function expireWait(h: ReturnType<typeof harness>) {
  h.advance(10 * 60_000);
  h.db.run("UPDATE tasks SET dispatch_deferred_until = NULL WHERE id = ?", [CARD]);
}

describe("Cloud senza ambiente attivo sull'account", () => {
  it("la card si ferma con la causa, non resta in attesa di un nodo «che non risponde»", async () => {
    const h = harness({
      floor: false,
      createRunError: () => new CloudSetupError("nessun ambiente cloud attivo sull'account"),
    });
    h.seed(CARD, { machineId: CLOUD });
    // The same answer start after start: parked after NODE_SETUP_POLLS of them in a row.
    for (let i = 1; i < NODE_SETUP_POLLS; i++) {
      await h.tick();
      expect(h.task(CARD).status).toBe("todo");
      expireWait(h);
    }
    await h.tick();
    const t = h.task(CARD);
    expect(t.status).not.toBe("todo");
    expect(t.dispatchDeferredUntil ?? null).toBeNull();
    const thread = h.svc.get(CARD)!.comments.map((c) => c.content).join("\n");
    expect(thread).toContain("nessun ambiente cloud attivo sull'account");
    expect(thread).not.toContain("non risponde");
  });

  it("una sola lettura fallita delle credenziali alla partenza: rinvio, poi la card riparte da sola", async () => {
    let fail = true;
    const h = harness({
      floor: false,
      createRunError: () => {
        if (!fail) return null;
        fail = false;
        return new CloudSetupError("credenziali del cloud non leggibili: voce assente nel Portachiavi");
      },
    });
    h.seed(CARD, { machineId: CLOUD });
    await h.tick();
    expect(h.task(CARD).status).toBe("todo");
    expect(h.task(CARD).dispatchDeferredUntil ?? null).not.toBeNull();
    expect(h.created).toHaveLength(0);
    expireWait(h);
    await h.tick();
    expect(h.created).toHaveLength(1);
    expect(h.task(CARD).status).toBe("in_progress");
    expect(h.task(CARD).machineId).toBe(CLOUD);
  });

  it("errori d'account alternati a un errore di rete non si sommano", async () => {
    const answers = ["setup", "setup", "net", "setup", "setup"];
    const h = harness({
      floor: false,
      createRunError: () => {
        const a = answers.shift();
        if (a === "setup") return new CloudSetupError("credenziali del cloud non leggibili");
        if (a === "net") return new Error("fetch failed");
        return null;
      },
    });
    h.seed(CARD, { machineId: CLOUD });
    for (let i = 0; i < 5; i++) {
      await h.tick();
      expect(h.task(CARD).status).toBe("todo");
      expireWait(h);
    }
    await h.tick();
    expect(h.task(CARD).status).toBe("in_progress");
  });

  it("un errore di rete resta un nodo muto: si riprova", async () => {
    const h = harness({ floor: false, createRunError: () => new Error("fetch failed") });
    h.seed(CARD, { machineId: CLOUD });
    await h.tick();
    expect(h.task(CARD).status).toBe("todo");
    expect(h.task(CARD).dispatchError).toBeString();
  });
});

/**
 * NO FREE SEAT ANYWHERE: every machine is filled (`fillMachine`), and the one
 * rule left (a free seat elsewhere wins at once) has nothing to offer the
 * card. These cases used to measure the floor's two-minute hold, which no
 * longer gates anything: what they pin down now is that an interrupted wait,
 * however long, never turns into a move on its own.
 */
describe("overflow: senza un posto libero da nessuna parte la card resta sul Mac, comunque vada l'attesa", () => {
  it("un giro fermato da un'altra attesa (tetto di spesa): senza posto da nessuna parte la card resta comunque ferma", async () => {
    const h = harness();
    fillMachine(h, CLOUD, OVERFLOW_SLOTS.cloud);
    fillMachine(h, PC, OVERFLOW_SLOTS.node);
    h.seed(CARD, { costCents: 500 });
    await h.tick(); // held by memory: the clock starts
    h.advance(90_000);
    h.svc.getSpendCaps = () => ({ perTaskCents: 100, perDayCents: 0 });
    await h.tick(); // held by the spend cap, not by memory: the clock stops
    h.svc.getSpendCaps = () => ({ perTaskCents: 0, perDayCents: 0 });
    h.advance(60_000); // 150 s since the first hold, 60 s since this one
    await h.tick();
    expect(h.task(CARD).machineId).toBeNull();
    h.advance(5 * 60_000);
    await h.tick();
    expect(h.task(CARD).machineId).toBeNull();
    expect(h.created).toEqual([]);
  });

  it("una card che esce da Todo e ci torna: senza posto da nessuna parte la card resta comunque ferma", async () => {
    const h = harness();
    fillMachine(h, CLOUD, OVERFLOW_SLOTS.cloud);
    fillMachine(h, PC, OVERFLOW_SLOTS.node);
    h.seed(CARD);
    await h.tick();
    h.advance(90_000);
    h.db.run("UPDATE tasks SET status = 'backlog' WHERE id = ?", [CARD]);
    await h.tick();
    h.db.run("UPDATE tasks SET status = 'todo' WHERE id = ?", [CARD]);
    h.advance(60_000);
    await h.tick();
    expect(h.task(CARD).machineId).toBeNull();
    h.advance(5 * 60_000);
    await h.tick();
    expect(h.task(CARD).machineId).toBeNull();
    expect(h.created).toEqual([]);
  });
});

describe("overflow: lo spazio sulle altre macchine", () => {
  it("un giro sposta al massimo OVERFLOW_MAX_PER_ROUND card", async () => {
    const h = harness();
    const ids = ["c-1", "c-2", "c-3"];
    for (const id of ids) h.seed(id);
    await settleTwoRounds(h);
    expect(ids.filter((id) => h.task(id).machineId === CLOUD)).toHaveLength(OVERFLOW_MAX_PER_ROUND);
    await h.tick();
    expect(ids.filter((id) => h.task(id).machineId === CLOUD)).toHaveLength(3);
  });

  it("il PC pieno ai suoi posti non prende la terza card", async () => {
    const h = harness({ cloudOnline: false });
    const ids = ["c-1", "c-2", "c-3"];
    for (const id of ids) h.seed(id);
    await settleTwoRounds(h);
    await h.tick();
    h.advance(60_000);
    await h.tick();
    expect(ids.filter((id) => h.task(id).machineId === PC)).toHaveLength(OVERFLOW_SLOTS.node);
    expect(ids.filter((id) => h.task(id).machineId === null)).toHaveLength(3 - OVERFLOW_SLOTS.node);
  });
});

describe("overflow: le due regole pure", () => {
  const m = (id: string, kind: "cloud" | "node", online: boolean): OverflowMachine => ({ id, name: id, kind, online });

  const ok: OverflowChoice = { cloudCredit: true, githubOrigin: true, model: null, load: () => 0 };
  const both = [m("pc", "node", true), m("cloud", "cloud", true)];

  it("Cloud con credito prima, poi il primo nodo online", () => {
    expect(pickOverflowMachine(both, ok)?.id).toBe("cloud");
    expect(pickOverflowMachine(both, { ...ok, cloudCredit: false })?.id).toBe("pc");
    expect(pickOverflowMachine([m("pc", "node", false), m("cloud", "cloud", false)], ok)).toBeNull();
  });

  it("Cloud solo con origin GitHub e modello Claude: altrimenti il PC", () => {
    expect(pickOverflowMachine(both, { ...ok, githubOrigin: false })?.id).toBe("pc");
    expect(pickOverflowMachine(both, { ...ok, model: "codex:gpt-5.5" })?.id).toBe("pc");
    expect(pickOverflowMachine(both, { ...ok, model: "claude-code:sonnet" })?.id).toBe("cloud");
    expect(pickOverflowMachine([m("cloud", "cloud", true)], { ...ok, model: "codex" })).toBeNull();
  });

  it("una macchina ai suoi posti non prende altro", () => {
    expect(pickOverflowMachine(both, { ...ok, load: (id) => (id === "cloud" ? OVERFLOW_SLOTS.cloud : 0) })?.id).toBe("pc");
    expect(pickOverflowMachine(both, { ...ok, load: (id) => (id === "cloud" ? OVERFLOW_SLOTS.cloud : OVERFLOW_SLOTS.node) })).toBeNull();
    expect(pickOverflowMachine([{ ...m("pc", "node", true), slots: 5 }], { ...ok, load: () => 4 })?.id).toBe("pc");
  });

  it("i modelli che il cloud esegue", () => {
    for (const yes of [null, "", "opus", "claude-code:sonnet", "claude-opus-5-5", "claude-code"]) expect(cloudRunsModel(yes)).toBe(true);
    for (const no of ["codex", "codex:gpt-5.5", "gpt-5.5", "openai:o5", "gemini-3"]) expect(cloudRunsModel(no)).toBe(false);
  });

  it("solo le card che girerebbero qui, senza marcatura, con l'interruttore acceso", () => {
    expect(overflowEligible({ machineId: null }, {}, LOCAL)).toBe(true);
    expect(overflowEligible({ machineId: LOCAL }, {}, LOCAL)).toBe(true);
    expect(overflowEligible({ machineId: PC }, {}, LOCAL)).toBe(false);
    expect(overflowEligible({ machineId: null, stayLocal: true }, {}, LOCAL)).toBe(false);
    expect(overflowEligible({ machineId: null }, { dispatchStayLocal: true }, LOCAL)).toBe(false);
    expect(overflowEligible({ machineId: null }, { dispatchOverflow: false }, LOCAL)).toBe(false);
  });
});

describe("verifica del 31/10: un giro che non trattiene la card per memoria non la fa partire altrove", () => {
  /**
   * Held at 0 s, `interrupt` for one round at 90 s, held again at 150 s. Every
   * machine is filled (`fillMachine`), so the one rule left (a free seat
   * elsewhere) finds nothing: the card stays here through the interruption and
   * after it, which is what each of these cases must leave unbroken.
   */
  async function brokenAt150(h: ReturnType<typeof harness>, interrupt: () => void, restore: () => void) {
    fillMachine(h, CLOUD, OVERFLOW_SLOTS.cloud);
    fillMachine(h, PC, OVERFLOW_SLOTS.node);
    h.seed(CARD);
    await h.tick(); // held by memory: the clock starts
    h.advance(90_000);
    interrupt();
    await h.tick();
    restore();
    h.advance(60_000); // 150 s since the first hold, 60 s since the interruption
    await h.tick();
    expect(h.task(CARD).machineId).toBeNull();
    h.advance(5 * 60_000);
    await h.tick();
    expect(h.task(CARD).machineId).toBeNull();
    expect(h.created).toEqual([]);
  }

  it("un pesante in volo", async () => {
    const h = harness();
    const real = h.svc.hasHeavyInFlight;
    await brokenAt150(h, () => { h.svc.hasHeavyInFlight = () => true; }, () => { h.svc.hasHeavyInFlight = real; });
  });

  it("un rinvio (dispatch_deferred_until nel futuro)", async () => {
    const h = harness();
    await brokenAt150(
      h,
      // The deferral gate reads the wall clock, not the injected one.
      () => { h.db.run("UPDATE tasks SET dispatch_deferred_until = ? WHERE id = ?", [new Date(Date.now() + 3_600_000).toISOString(), CARD]); },
      () => { h.db.run("UPDATE tasks SET dispatch_deferred_until = NULL WHERE id = ?", [CARD]); },
    );
  });

  it("la board in pausa", async () => {
    const h = harness();
    await brokenAt150(
      h,
      () => { h.svc.updateBoardSettings(PID, { dispatchPaused: true }); },
      () => { h.svc.updateBoardSettings(PID, { dispatchPaused: false }); },
    );
  });
});

describe("verifica del 31/10: i posti di una macchina contano le card che le sono assegnate", () => {
  it("PC muto (acceso ma non risponde): 6 card, 2 posti, ne finiscono lì al più 2", async () => {
    const h = harness({ cloudOnline: false, createRunError: () => new Error("fetch failed") });
    const ids = ["c-1", "c-2", "c-3", "c-4", "c-5", "c-6"];
    for (const id of ids) h.seed(id);
    await settleTwoRounds(h);
    for (let i = 0; i < 8; i++) { h.advance(6 * 60_000); await h.tick(); }
    expect(ids.filter((id) => h.task(id).machineId === PC)).toHaveLength(OVERFLOW_SLOTS.node);
  });

  it("PC addormentato e svegliabile: la sveglia non allarga il danno", async () => {
    const h = harness({ cloudCredit: false, pcOnline: false, pcWakeable: true, createRunError: () => new Error("fetch failed") });
    const ids = ["c-1", "c-2", "c-3", "c-4", "c-5", "c-6"];
    for (const id of ids) h.seed(id);
    await settleTwoRounds(h);
    for (let i = 0; i < 8; i++) { h.advance(6 * 60_000); await h.tick(); }
    expect(ids.filter((id) => h.task(id).machineId === PC)).toHaveLength(OVERFLOW_SLOTS.node);
  });

  it("il conteggio legge le card in coda o con una corsa aperta su quella macchina, non quelle chiuse o archiviate", () => {
    const h = harness();
    h.seed("in-coda", { machineId: PC });
    h.seed("al-lavoro", { machineId: PC });
    h.seed("chiusa", { machineId: PC });
    h.seed("archiviata", { machineId: PC });
    h.seed("altrove", { machineId: CLOUD });
    h.db.run("UPDATE tasks SET status = 'in_progress', node_run_open = 1 WHERE id = 'al-lavoro'");
    h.db.run("UPDATE tasks SET status = 'done' WHERE id = 'chiusa'");
    h.db.run("UPDATE tasks SET archived = 1 WHERE id = 'archiviata'");
    expect(h.svc.countOnMachine(PC)).toBe(2);
  });

  // 26/11: `nodes[].used` in the capacity line counted every card with a
  // `machine_id` pin, even one the primary had already closed, or one
  // waiting on something other than the node. A seat now counts only a run
  // the primary still believes is open.
  it("una corsa chiusa sul primario libera il posto, anche con machine_id ancora scritto", () => {
    const h = harness();
    h.seed("chiusa-ma-pinnata", { machineId: PC });
    h.db.run("UPDATE tasks SET status = 'in_progress', node_run_open = 0 WHERE id = 'chiusa-ma-pinnata'");
    expect(h.svc.countOnMachine(PC)).toBe(0);
  });

  it("una card in attesa di qualcosa che non è il nodo (una persona, una condizione) lascia il posto", () => {
    const h = harness();
    h.seed("in-attesa-altrove", { machineId: PC });
    h.db.run(
      "UPDATE tasks SET status = 'todo', dispatch_state = 'waiting', wait_source = 'agent', node_run_open = 0 WHERE id = 'in-attesa-altrove'",
    );
    expect(h.svc.countOnMachine(PC)).toBe(0);
  });

  it("una card in attesa del nodo stesso (silenzioso) resta contata", () => {
    const h = harness();
    h.seed("in-attesa-del-nodo", { machineId: PC });
    h.db.run(
      "UPDATE tasks SET status = 'todo', dispatch_state = 'waiting', wait_source = 'machine', node_run_open = 0 WHERE id = 'in-attesa-del-nodo'",
    );
    expect(h.svc.countOnMachine(PC)).toBe(1);
  });

  it("4 posti presi con 2 corse aperte sul primario: dopo un giro i posti contati sono 2", () => {
    const h = harness();
    h.seed("corsa-1", { machineId: CLOUD });
    h.seed("corsa-2", { machineId: CLOUD });
    h.seed("ferma-1", { machineId: CLOUD });
    h.seed("ferma-2", { machineId: CLOUD });
    h.db.run("UPDATE tasks SET status = 'in_progress', node_run_open = 1 WHERE id IN ('corsa-1', 'corsa-2')");
    // The other two still carry `machine_id` but the primary never opened (or
    // already closed) a run for them: before the reconciliation, the old SQL
    // (`status IN ('todo','in_progress')`) counted all four.
    h.db.run("UPDATE tasks SET status = 'in_progress', node_run_open = 0 WHERE id = 'ferma-1'");
    h.db.run(
      "UPDATE tasks SET status = 'todo', dispatch_state = 'waiting', wait_source = 'agent', node_run_open = 0 WHERE id = 'ferma-2'",
    );
    expect(h.svc.countOnMachine(CLOUD)).toBe(2);
  });
});

describe("verifica del 31/10: le card legate a questa macchina non si spostano", () => {
  it("una card delegata (policy vera, legata a questo Mac) resta qui e non finisce in backlog", async () => {
    const h = harness();
    const capability = putAgentStartCapability(h.db, {
      subjectType: "person", subjectId: "person-a", projectId: PID, machineId: LOCAL,
      repositoryKey: "github.com/acme/alpha", model: "claude-code:sonnet", effort: "medium",
      maxDurationMinutes: 30, grantedByPersonId: "owner", now: h.now(),
    });
    const born = h.svc.create({ projectId: PID, text: "card di un ospite", status: "backlog" });
    queueDelegatedRun(h.db, { taskId: born.id, capability, initiatorPersonId: "person-a", initiatorDeviceId: "device-a", now: h.now() });
    // The policy is live: the card is a real delegated one, held by the floor here.
    expect(delegatedPolicyForTask(h.db, born.id, h.now(), LOCAL)?.id).toBe(capability.id);
    expect(h.task(born.id).machineId).toBe(LOCAL);
    await settleTwoRounds(h);
    await h.tick();
    expect(h.task(born.id).machineId).toBe(LOCAL);
    expect(h.task(born.id).status).toBe("todo");
    expect(h.created).toEqual([]);
    expect(h.thread(born.id)).not.toContain("no longer valid");
  });

  it("una card con 3 file non committati resta sul Mac", async () => {
    const h = harness();
    h.seed(CARD);
    h.db.run("UPDATE tasks SET delivery_uncommitted_files = 3 WHERE id = ?", [CARD]);
    await settleTwoRounds(h);
    await h.tick();
    expect(h.task(CARD).machineId).toBeNull();
    expect(h.created).toEqual([]);
  });

  it("una card specchio (node-run:) resta sulla macchina che la esegue", async () => {
    const h = harness();
    h.seed(CARD);
    h.db.run("UPDATE tasks SET claude_task_id = 'node-run:origin-123' WHERE id = ?", [CARD]);
    await settleTwoRounds(h);
    await h.tick();
    expect(h.task(CARD).machineId).toBeNull();
    expect(h.created).toEqual([]);
  });

  it("anche il CAS del servizio rifiuta le tre card", () => {
    const h = harness();
    for (const id of ["deleg", "sporca", "specchio", "libera"]) h.seed(id);
    h.db.run("UPDATE tasks SET delegated_start_capability_id = 'cap-1' WHERE id = 'deleg'");
    h.db.run("UPDATE tasks SET delivery_uncommitted_files = 3 WHERE id = 'sporca'");
    h.db.run("UPDATE tasks SET claude_task_id = 'node-run:o-1' WHERE id = 'specchio'");
    for (const id of ["deleg", "sporca", "specchio"]) {
      expect(h.svc.overflowToMachine({ taskId: id, machineId: CLOUD, localMachineId: LOCAL })).toBeNull();
    }
    expect(h.svc.overflowToMachine({ taskId: "libera", machineId: CLOUD, localMachineId: LOCAL })?.machineId).toBe(CLOUD);
  });

  it("la regola pura", () => {
    expect(overflowEligible({ machineId: LOCAL, delegated: true }, {}, LOCAL)).toBe(false);
    expect(overflowEligible({ machineId: null, claudeTaskId: "node-run:o-1" }, {}, LOCAL)).toBe(false);
    expect(overflowEligible({ machineId: null, claudeTaskId: "altro-id" }, {}, LOCAL)).toBe(true);
    expect(overflowEligible({ machineId: null, deliveryUncommittedFiles: 3 }, {}, LOCAL)).toBe(false);
    expect(overflowEligible({ machineId: null, deliveryUncommittedFiles: 0 }, {}, LOCAL)).toBe(true);
  });
});

describe("verifica del 31/10: errore d'account su una corsa viva", () => {
  it("pochi giri di fila la fermano con la causa, non 30 giri «non ha risposto»", async () => {
    const readRunError: { current: (() => Error) | null } = { current: null };
    const h = harness({ floor: false, readRunError });
    h.seed(CARD, { machineId: CLOUD });
    await h.tick();
    expect(h.task(CARD).status).toBe("in_progress");
    await h.poll();
    readRunError.current = () => new CloudSetupError("l'API del cloud rifiuta l'account (401 su /v1/sessions)");
    // Not on the first answer (31/10, fourth round): a few in a row, far fewer than NODE_DEAD_POLLS.
    for (let i = 1; i < NODE_SETUP_POLLS; i++) { await h.poll(); expect(h.task(CARD).status).toBe("in_progress"); }
    await h.poll();
    const t = h.task(CARD);
    expect(t.status).not.toBe("in_progress");
    expect(t.status).not.toBe("todo");
    expect(h.thread(CARD)).toContain("rifiuta l'account");
    expect(h.thread(CARD)).not.toContain("non ha risposto");
  });

  it("un errore di rete su una corsa viva resta un giro fallito: la card resta al lavoro", async () => {
    const readRunError: { current: (() => Error) | null } = { current: () => new Error("fetch failed") };
    const h = harness({ floor: false, readRunError });
    h.seed(CARD, { machineId: CLOUD });
    await h.tick();
    await h.poll();
    expect(h.task(CARD).status).toBe("in_progress");
  });
});

describe("verifica del 31/10 (terzo giro): una card che esce da Todo e rientra", () => {
  /** Held, then out of Todo while its board has nothing else queued, then back. */
  async function outAndBack(h: ReturnType<typeof harness>, rounds: number) {
    h.seed(CARD);
    await h.poll();
    h.advance(10_000);
    await h.poll();
    h.svc.update({ taskId: CARD, actor: "human", by: "attilio", patch: { status: "backlog" } });
    h.dispatcher.onLeaveTodo(CARD);
    for (let i = 0; i < rounds; i++) { h.advance(600_000); await h.poll(); }
    h.svc.update({ taskId: CARD, actor: "human", by: "attilio", patch: { status: "todo" } });
    h.dispatcher.onEnterTodo(PID, CARD);
    await h.poll();
  }

  it("sola sulla board, un'ora in backlog: al rientro resta qui (senza posto da nessuna parte)", async () => {
    const h = harness();
    fillMachine(h, CLOUD, OVERFLOW_SLOTS.cloud);
    fillMachine(h, PC, OVERFLOW_SLOTS.node);
    await outAndBack(h, 6);
    expect(h.task(CARD).machineId).toBeNull();
    h.advance(110_000);
    await h.poll();
    expect(h.task(CARD).machineId).toBeNull();
    h.advance(20_000);
    await h.poll();
    expect(h.task(CARD).machineId).toBeNull();
    expect(h.created).toEqual([]);
  });

  it("sola sulla board, backlog e ritorno fra due giri: resta qui (senza posto da nessuna parte)", async () => {
    const h = harness();
    fillMachine(h, CLOUD, OVERFLOW_SLOTS.cloud);
    fillMachine(h, PC, OVERFLOW_SLOTS.node);
    h.seed(CARD);
    await h.poll();
    h.advance(5 * 60_000);
    h.svc.update({ taskId: CARD, actor: "human", by: "attilio", patch: { status: "backlog" } });
    h.dispatcher.onLeaveTodo(CARD);
    h.svc.update({ taskId: CARD, actor: "human", by: "attilio", patch: { status: "todo" } });
    h.dispatcher.onEnterTodo(PID, CARD);
    await h.poll();
    expect(h.task(CARD).machineId).toBeNull();
  });

  it("uscita da Todo senza i due ganci (scrittura diretta): al rientro resta qui, nessun posto libero", async () => {
    const h = harness();
    fillMachine(h, CLOUD, OVERFLOW_SLOTS.cloud);
    fillMachine(h, PC, OVERFLOW_SLOTS.node);
    h.seed(CARD);
    await h.poll();
    h.advance(10_000);
    h.db.run("UPDATE tasks SET status = 'backlog' WHERE id = ?", [CARD]);
    await h.poll();
    h.advance(120_000);
    h.db.run("UPDATE tasks SET status = 'todo' WHERE id = ?", [CARD]);
    await h.poll();
    expect(h.task(CARD).machineId).toBeNull();
  });
});

describe("verifica del 31/10 (terzo giro): il lavoro non committato nel flusso vero", () => {
  /** Delivered by the system with `n` uncommitted files, as the dispatcher does. */
  function deliveredDirty(h: ReturnType<typeof harness>, n: number) {
    h.seed(CARD);
    h.db.run("UPDATE tasks SET status = 'in_progress' WHERE id = ?", [CARD]);
    h.svc.deliverToReviewBySystem({ taskId: CARD, reason: "turno finito senza commit", uncommittedFiles: n });
    expect(h.task(CARD).deliveryUncommittedFiles).toBe(n);
  }

  it("review -> todo vero con 3 file non committati: la card resta sul Mac", async () => {
    const h = harness();
    deliveredDirty(h, 3);
    h.svc.update({ taskId: CARD, actor: "human", by: "attilio", patch: { status: "todo" } });
    expect(h.task(CARD).deliveryUncommittedFiles).toBeNull();
    await settleTwoRounds(h);
    await h.tick();
    expect(h.task(CARD).machineId).toBeNull();
    expect(h.created).toEqual([]);
  });

  it("rifiuto in review con 3 file non committati: la card resta sul Mac", async () => {
    const h = harness();
    deliveredDirty(h, 3);
    h.svc.reviewDecision({ taskId: CARD, by: "attilio", decision: "reject", comment: "rifai" });
    // The reject reopens the card (in_progress) and clears the snapshot; it waits in Todo afterwards.
    expect(h.task(CARD).deliveryUncommittedFiles).toBeNull();
    h.svc.update({ taskId: CARD, actor: "human", by: "attilio", patch: { status: "todo" } });
    await settleTwoRounds(h);
    await h.tick();
    expect(h.task(CARD).machineId).toBeNull();
    expect(h.created).toEqual([]);
  });

  it("anche il CAS del servizio la rifiuta dopo il rientro in coda", () => {
    const h = harness();
    deliveredDirty(h, 3);
    h.svc.update({ taskId: CARD, actor: "human", by: "attilio", patch: { status: "todo" } });
    expect(h.svc.overflowToMachine({ taskId: CARD, machineId: CLOUD, localMachineId: LOCAL })).toBeNull();
  });

  it("consegna pulita (0 file) e rientro: la card si sposta", async () => {
    const h = harness();
    deliveredDirty(h, 0);
    h.svc.update({ taskId: CARD, actor: "human", by: "attilio", patch: { status: "todo" } });
    await settleTwoRounds(h);
    await h.tick();
    expect(h.task(CARD).machineId).toBe(CLOUD);
  });

  it("una nuova consegna registrata qui toglie il vecchio conteggio", async () => {
    const h = harness();
    deliveredDirty(h, 3);
    h.svc.update({ taskId: CARD, actor: "human", by: "attilio", patch: { status: "todo" } });
    h.svc.recordDelivery({ taskId: CARD, branch: "topics/clean", commit: "abc1234", stat: null });
    h.db.run("UPDATE tasks SET delivery_branch = NULL, delivery_commit = NULL WHERE id = ?", [CARD]);
    await settleTwoRounds(h);
    await h.tick();
    expect(h.task(CARD).machineId).toBe(CLOUD);
  });
});

describe("verifica del 31/10 (quarto giro)", () => {
  it("punto 3: una card «prima il piano» non si sposta, resta sul Mac", async () => {
    const h = harness();
    h.seed(CARD);
    h.db.run("UPDATE tasks SET plan_first = 1 WHERE id = ?", [CARD]);
    expect(h.task(CARD).planFirst).toBe(true);
    await settleTwoRounds(h);
    for (let i = 0; i < 3; i++) { h.advance(60_000); await h.poll(); }
    expect(h.task(CARD).machineId).toBeNull();
    expect(h.created).toHaveLength(0);
    expect(overflowEligible({ machineId: null, planFirst: true }, {}, LOCAL)).toBe(false);
  });

  it("punto 4: un errore di credenziali solo, su una corsa Cloud viva, non la ferma", async () => {
    const readRunError: { current: (() => Error) | null } = { current: null };
    const h = harness({ floor: false, readRunError });
    h.seed(CARD, { machineId: CLOUD });
    await h.tick();
    await h.poll();
    expect(h.task(CARD).status).toBe("in_progress");
    readRunError.current = () => new CloudSetupError("credenziali del cloud non leggibili: voce assente nel Portachiavi");
    await h.poll();
    readRunError.current = null;
    await h.poll();
    expect(h.task(CARD).status).toBe("in_progress");
    // The count starts over after an answer: NODE_SETUP_POLLS - 1 more errors still do not park.
    readRunError.current = () => new CloudSetupError("credenziali del cloud non leggibili: voce assente nel Portachiavi");
    for (let i = 1; i < NODE_SETUP_POLLS; i++) await h.poll();
    expect(h.task(CARD).status).toBe("in_progress");
    expect(NODE_SETUP_POLLS).toBeGreaterThan(1);
    expect(NODE_SETUP_POLLS).toBeLessThan(NODE_DEAD_POLLS);
  });

  it("punto 5: la nota non promette che la macchina scelta a mano trattenga la card", async () => {
    const h = harness();
    h.seed(CARD);
    h.svc.update({ taskId: CARD, actor: "human", by: "attilio", patch: { machineId: LOCAL } });
    await settleTwoRounds(h);
    // Choosing this Mac by hand reads as the default: the card moves anyway...
    expect(h.task(CARD).machineId).toBe(CLOUD);
    // ...so the line on the card must not say that choosing it keeps the card here.
    const note = overflowNoteImmediate("Cloud Claude");
    expect(note).not.toContain("rimetti la macchina a mano");
    expect(note).toContain("«solo Mac»");
    expect(h.thread(CARD)).toContain("non basta");
  });

  it("il warm-up del pavimento non è il pavimento di memoria: senza posti liberi la card resta", async () => {
    const h = harness({ verdict: { ...BLOCKED, kind: "memory_warmup" } });
    // The immediate (room-first) path does not read the floor's kind at all,
    // so with a free seat anywhere it would move the card regardless of
    // warm-up vs real memory - saturating both machines isolates the one
    // thing this test is actually about.
    fillMachine(h, CLOUD, OVERFLOW_SLOTS.cloud);
    fillMachine(h, PC, OVERFLOW_SLOTS.node);
    h.seed(CARD);
    await settleTwoRounds(h);
    for (let i = 0; i < 3; i++) { h.advance(60_000); await h.poll(); }
    expect(h.task(CARD).machineId).toBeNull();
    expect(h.created).toHaveLength(0);
  });

  it("l'auto-dispatch spento in mezzo non fa partire niente (senza posto da nessuna parte)", async () => {
    const h = harness();
    fillMachine(h, CLOUD, OVERFLOW_SLOTS.cloud);
    fillMachine(h, PC, OVERFLOW_SLOTS.node);
    h.seed(CARD);
    await h.poll();
    h.advance(90_000);
    h.svc.updateBoardSettings(PID, { autoDispatch: false });
    await h.poll();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    h.advance(60_000); // 150 s since the first hold, 60 s since the switch came back on
    await h.poll();
    expect(h.task(CARD).machineId).toBeNull();
    h.advance(5 * 60_000);
    await h.poll();
    expect(h.task(CARD).machineId).toBeNull();
    expect(h.created).toEqual([]);
  });

  it("nemmeno la board in pausa in mezzo fa partire niente (senza posto da nessuna parte)", async () => {
    const h = harness();
    fillMachine(h, CLOUD, OVERFLOW_SLOTS.cloud);
    fillMachine(h, PC, OVERFLOW_SLOTS.node);
    h.seed(CARD);
    await h.poll();
    h.advance(90_000);
    h.svc.updateBoardSettings(PID, { dispatchPaused: true });
    await h.poll();
    h.svc.updateBoardSettings(PID, { dispatchPaused: false });
    h.advance(60_000);
    await h.poll();
    expect(h.task(CARD).machineId).toBeNull();
    h.advance(5 * 60_000);
    await h.poll();
    expect(h.task(CARD).machineId).toBeNull();
    expect(h.created).toEqual([]);
  });
});

describe("limite settimanale del Cloud", () => {
  const resetsIn = (days: number) => {
    const d = new Date(Date.now() + days * 86_400_000);
    return `You've hit your weekly limit · resets ${d.toLocaleString("en-US", { month: "short", timeZone: "UTC" })} ${d.getUTCDate()}, 4am (UTC)`;
  };
  const clean = () => { resetProviderHoldStore(); clearProviderHold(CLOUD_HOLD_KEY); };

  it("la corsa Cloud torna col limite: fermo registrato, card in coda sul Mac, il turno dopo va sul PC", async () => {
    clean();
    try {
      const limitHit = { current: false };
      const h = harness({
        realCredit: true,
        runReport: () => (limitHit.current
          ? { status: "review", dispatchError: resetsIn(3) }
          : {}),
      });
      // The PC starts full: a free seat there would otherwise pick the card
      // up the moment it bounces back to Todo, before this test gets to
      // check the in-between "back on the Mac, nothing moved yet" state.
      fillMachine(h, PC, OVERFLOW_SLOTS.node);
      h.seed(CARD);
      await settleTwoRounds(h);
      expect(h.task(CARD).machineId).toBe(CLOUD);
      expect(h.created).toHaveLength(1);

      limitHit.current = true;
      await h.poll();
      expect(providerHold(Date.now(), CLOUD_HOLD_KEY)?.window).toBe("seven_day");
      expect(providerHold(Date.now(), CLOUD_HOLD_KEY)!.untilMs).toBeGreaterThan(Date.now() + 86_400_000);
      expect(h.task(CARD).status).toBe("todo");
      expect(h.task(CARD).machineId).toBeNull();
      expect(h.thread(CARD)).not.toContain("Consegna senza riassunto");

      // The PC frees up now: the next turn finds it with room and takes the card.
      freeMachine(h, PC);
      await settleTwoRounds(h);
      expect(h.task(CARD).machineId).toBe(PC);
    } finally { clean(); }
  });

  it("una card messa a mano sul Cloud non torna in coda all'infinito: resta in review col messaggio", async () => {
    clean();
    try {
      const h = harness({ realCredit: true, runReport: () => ({ status: "review", dispatchError: resetsIn(3) }) });
      h.seed(CARD, { machineId: CLOUD });
      await h.tick();
      await h.poll();
      expect(providerHold(Date.now(), CLOUD_HOLD_KEY)).not.toBeNull();
      expect(h.task(CARD).status).toBe("review");
      expect(h.task(CARD).machineId).toBe(CLOUD);
    } finally { clean(); }
  });

  it("una consegna vera col limite nel messaggio non si perde: arriva in review", async () => {
    clean();
    try {
      const h = harness({
        realCredit: true,
        runReport: () => ({ status: "review", deliveryBranch: "topics/x", deliveryCommit: "abc1234", dispatchError: resetsIn(2) }),
      });
      h.seed(CARD, { machineId: CLOUD });
      await h.tick();
      await h.poll();
      expect(providerHold(Date.now(), CLOUD_HOLD_KEY)).not.toBeNull();
      expect(h.task(CARD).status).toBe("review");
      expect(h.task(CARD).deliveryBranch).toBe("topics/x");
    } finally { clean(); }
  });
});

describe("overflow: il vincolo «solo Mac» messo dopo una corsa vuota scade", () => {
  it("vincolo con scadenza passata: la card esce come una non marcata", async () => {
    const h = harness();
    h.seed(CARD, { stayLocal: true });
    h.db.run("UPDATE tasks SET stay_local_until = ? WHERE id = ?", [new Date(Date.now() - 60_000).toISOString(), CARD]);
    expect(h.task(CARD).stayLocal).toBe(false);
    await settleTwoRounds(h);
    expect(h.task(CARD).machineId).toBe(CLOUD);
  });

  it("vincolo con scadenza futura: resta ferma", async () => {
    const h = harness();
    h.seed(CARD, { stayLocal: true });
    h.db.run("UPDATE tasks SET stay_local_until = ? WHERE id = ?", [new Date(Date.now() + 3_600_000).toISOString(), CARD]);
    await settleTwoRounds(h);
    expect(h.task(CARD).machineId).toBeNull();
  });

  it("una persona che rimette «solo Mac» toglie la scadenza: vale per sempre", () => {
    const h = harness();
    h.seed(CARD, { stayLocal: true });
    h.db.run("UPDATE tasks SET stay_local_until = ? WHERE id = ?", [new Date(Date.now() - 60_000).toISOString(), CARD]);
    h.svc.update({ taskId: CARD, actor: "human", by: "attilio", patch: { stayLocal: true } });
    expect(h.task(CARD).stayLocal).toBe(true);
  });
});

describe("overflow: una corsa vuota su un nodo lo salta, non ferma la card sul Mac pieno", () => {
  it("il nodo della corsa vuota è saltato: la card va sull'altro (10/11, cinque card ferme nella coda di memoria)", async () => {
    const h = harness();
    h.seed(CARD);
    h.svc.update({ taskId: CARD, actor: "agent", by: "dispatcher", patch: { overflowSkip: { machineId: CLOUD, until: new Date(Date.now() + 3_600_000).toISOString() } } });
    expect(h.task(CARD).stayLocal).toBe(false);
    await settleTwoRounds(h);
    expect(h.task(CARD).machineId).toBe(PC);
  });

  it("due nodi già saltati restano saltati: la card non rimbalza e resta qui", async () => {
    const h = harness();
    h.seed(CARD);
    h.svc.update({ taskId: CARD, actor: "agent", by: "dispatcher", patch: { overflowSkip: { machineId: `${CLOUD},${PC}`, until: new Date(Date.now() + 3_600_000).toISOString() } } });
    await settleTwoRounds(h);
    expect(h.task(CARD).machineId ?? null).toBeNull();
  });

  it("il salto scaduto non conta più", async () => {
    const h = harness();
    h.seed(CARD);
    h.svc.update({ taskId: CARD, actor: "agent", by: "dispatcher", patch: { overflowSkip: { machineId: CLOUD, until: new Date(Date.now() - 60_000).toISOString() } } });
    await settleTwoRounds(h);
    expect(h.task(CARD).machineId).toBe(CLOUD);
  });

  it("la corsa vuota rimette in coda con il salto, senza «solo Mac»", async () => {
    const { returnEmptyNodeRunToTodo } = await import("./task-dispatcher-remote-node-empty");
    const h = harness();
    h.seed(CARD, { machineId: PC });
    h.db.run("UPDATE tasks SET overflowed_at = ? WHERE id = ?", [new Date().toISOString(), CARD]);
    const ok = returnEmptyNodeRunToTodo({ svc: h.svc, releaseAndEmit: (a) => h.svc.release(a), emit: () => {}, log: () => {} }, h.task(CARD), "PC Windows");
    expect(ok).toBe(true);
    expect(h.task(CARD).stayLocal).toBe(false);
    expect(h.task(CARD).overflowSkipMachine).toBe(PC);
  });
});

describe("overflow: una card che nomina file di questo Mac non va su un nodo", () => {
  it("percorsi della home o launchd la tengono qui (10/11: cinque card tornate vuote due volte dal PC)", () => {
    expect(overflowEligible({ machineId: null, description: "tocca ~/.claude/jarvis/tools/usage-hub" }, {}, LOCAL)).toBe(false);
    expect(overflowEligible({ machineId: null, text: "plist in LaunchAgents" }, {}, LOCAL)).toBe(false);
    expect(overflowEligible({ machineId: null, description: "server/services/tasks.ts" }, {}, LOCAL)).toBe(true);
  });
});
