/**
 * THE OVERFLOW: a card held by THIS Mac's memory floor for more than two
 * minutes goes to a machine where the floor does not apply.
 *
 * The contract:
 *  1. Mac under the floor + Cloud Claude online: past two minutes the card
 *     leaves with `machine_id` = Cloud within one round, and is launched there;
 *     before two minutes it stays;
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
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { createTaskService, type TaskService } from "./tasks";
import { createTaskDispatcher, type DispatcherDeps } from "./task-dispatcher";
import type { ResourceFloorVerdict } from "./dispatch-capacity";
import type { TurnEndInfo } from "../providers/stop-reason";
import {
  OVERFLOW_AFTER_MS, OVERFLOW_MAX_PER_ROUND, OVERFLOW_SLOTS, cloudRunsModel, overflowEligible, pickOverflowMachine,
  type OverflowChoice, type OverflowMachine,
} from "./dispatch-overflow";
import { CloudSetupError } from "../providers/claude-cloud/api";
import { NODE_DEAD_POLLS, NODE_SETUP_POLLS } from "./task-dispatcher-remote-node";
import { overflowNote } from "./dispatch-overflow";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL } from "../db/test-schema";
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
  /** What `createRun` throws instead of answering (a cloud account without environments). */
  createRunError?: () => Error;
  /** What `readRun` throws instead of answering, while set (a live run's account refused). */
  readRunError?: { current: (() => Error) | null };
  /** The Mac under its memory floor (default) or free. */
  floor?: boolean;
  /** The floor's verdict while it holds (default `BLOCKED`, a memory floor). */
  verdict?: ResourceFloorVerdict;
  /** What pushing a card's own branch answers (default: it reaches origin). */
  ensure?: (branch: string) => { ok: true } | { ok: false; reason: string };
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
    { id: PC, name: NAME[PC], kind: "node", online: opts.pcOnline ?? true, wakeable: opts.pcWakeable ?? false },
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
        if (opts.createRunError) throw opts.createRunError();
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
        };
      },
      fetchBundle: async () => ({ empty: true as const }),
      cancelRun: async () => {},
      baseUrlOf: (id) => ADDRESS[id] ?? null,
      tokenOf: () => "tok",
      nameOf: (id) => NAME[id] ?? null,
      localMachineId: () => LOCAL,
      originUrlOf: async () => "git@github.com:acme/alpha.git",
      plantBranch: async () => ({ planted: true, commit: "c0ffeec0ffee", reason: null }),
      ensureBranchOnOrigin: async ({ branch }) => { pushed.push(branch); return opts.ensure?.(branch) ?? { ok: true }; },
    },
    overflowMachines: machines,
    githubOriginOf: async () => opts.github ?? true,
    cloudCredit: () => opts.cloudCredit ?? true,
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

/** Held once, then past the two minutes: the round the move must happen in. */
async function holdPastThreshold(h: ReturnType<typeof harness>) {
  await h.tick();
  h.advance(OVERFLOW_AFTER_MS + 1_000);
  await h.tick();
}

describe("overflow: una card ferma per la memoria del Mac va dove il pavimento non vale", () => {
  it("Mac sotto il pavimento e Cloud online: dopo 2 minuti la card esce con machine_id Cloud e parte lì", async () => {
    const h = harness();
    h.seed(CARD);

    await h.tick();
    // Under two minutes: held here, nothing moved.
    expect(h.task(CARD).machineId).toBeNull();
    expect(h.task(CARD).status).toBe("todo");
    h.advance(OVERFLOW_AFTER_MS - 10_000);
    await h.tick();
    expect(h.task(CARD).machineId).toBeNull();
    expect(h.created).toEqual([]);

    h.advance(20_000);
    await h.tick();
    expect(h.task(CARD).machineId).toBe(CLOUD);
    expect(h.task(CARD).overflowedAt).toBeString();
    expect(h.created).toEqual([{ baseUrl: "claude-cloud://", originTaskId: CARD }]);
    expect(h.task(CARD).status).toBe("in_progress");
    expect(h.turns).toEqual([]);
    const note = h.svc.get(CARD)!.comments.map((c) => c.content).find((c) => c.startsWith("Spostata su"));
    expect(note).toStartWith("Spostata su Cloud Claude: Mac pieno.");
  });

  it("anche la card con la macchina predefinita = questo Mac si sposta", async () => {
    const h = harness();
    h.seed(CARD, { machineId: LOCAL });
    await holdPastThreshold(h);
    expect(h.task(CARD).machineId).toBe(CLOUD);
  });

  it("una card marcata «solo Mac» resta ferma", async () => {
    const h = harness();
    h.seed(CARD, { stayLocal: true });
    await holdPastThreshold(h);
    h.advance(10 * 60_000);
    await h.tick();
    expect(h.task(CARD).machineId).toBeNull();
    expect(h.task(CARD).status).toBe("todo");
    expect(h.created).toEqual([]);
  });

  it("una card nata «solo Mac» (marcata alla creazione) resta ferma", async () => {
    const h = harness();
    const born = h.svc.create({ projectId: PID, text: "riavvia OpenClaw", status: "todo", stayLocal: true });
    expect(born.stayLocal).toBe(true);
    await holdPastThreshold(h);
    expect(h.task(born.id).machineId).toBeNull();
    expect(h.created).toEqual([]);
  });

  it("una board marcata «solo Mac» tiene ferme le sue card", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { dispatchStayLocal: true });
    h.seed(CARD);
    await holdPastThreshold(h);
    expect(h.task(CARD).machineId).toBeNull();
    expect(h.created).toEqual([]);
  });

  it("con l'interruttore della board spento non si sposta niente", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { dispatchOverflow: false });
    h.seed(CARD);
    await holdPastThreshold(h);
    expect(h.task(CARD).machineId).toBeNull();
    expect(h.created).toEqual([]);
  });

  it("Cloud offline e PC online: la card va sul PC", async () => {
    const h = harness({ cloudOnline: false });
    h.seed(CARD);
    await holdPastThreshold(h);
    expect(h.task(CARD).machineId).toBe(PC);
    expect(h.created).toEqual([{ baseUrl: "https://pc.local", originTaskId: CARD }]);
  });

  it("Cloud senza credito e PC online: la card va sul PC", async () => {
    const h = harness({ cloudCredit: false });
    h.seed(CARD);
    await holdPastThreshold(h);
    expect(h.task(CARD).machineId).toBe(PC);
  });

  it("nessuna macchina online: la card resta in coda sul Mac", async () => {
    const h = harness({ cloudOnline: false, pcOnline: false });
    h.seed(CARD);
    await holdPastThreshold(h);
    expect(h.task(CARD).machineId).toBeNull();
    expect(h.task(CARD).status).toBe("todo");
  });

  it("una card assegnata a mano a un'altra macchina non è toccata dall'overflow", async () => {
    const h = harness({ pcOnline: false });
    h.seed(CARD, { machineId: PC });
    await holdPastThreshold(h);
    expect(h.task(CARD).machineId).toBe(PC);
  });
});

describe("overflow: il ramo della card, l'origin, il modello", () => {
  it("sul nodo PC la card specchio con un ramo base fa nascere il worktree da lì, non da main", async () => {
    const h = harness({ floor: false });
    h.seed("specchio", { baseBranch: "topics/endless-calf" });
    h.seed("altra");
    await h.tick();
    expect(h.worktrees).toContainEqual({ baseBranch: "topics/endless-calf" });
    expect(h.worktrees).toContainEqual(undefined);
  });

  it("una card con un ramo di consegna va su Cloud partendo DA quel ramo, pushato prima", async () => {
    const h = harness();
    h.seed(CARD, { deliveryBranch: "topics/endless-calf" });
    await holdPastThreshold(h);
    // The push answers asynchronously: the move comes in the next round.
    await h.tick();
    expect(h.task(CARD).machineId).toBe(CLOUD);
    expect(h.pushed).toContain("topics/endless-calf");
    expect(h.bodies).toEqual([{ originTaskId: CARD, baseBranch: "topics/endless-calf" }]);
  });

  it("una card senza ramo parte dal default: nessun baseBranch, nessun push", async () => {
    const h = harness();
    h.seed(CARD);
    await holdPastThreshold(h);
    expect(h.bodies).toEqual([{ originTaskId: CARD, baseBranch: undefined }]);
    expect(h.pushed).toEqual([]);
  });

  it("un ramo che non arriva su origin tiene la card sul Mac", async () => {
    const h = harness({ ensure: () => ({ ok: false, reason: "push rifiutato: non-fast-forward" }) });
    h.seed(CARD, { deliveryBranch: "topics/endless-calf" });
    await holdPastThreshold(h);
    for (let i = 0; i < 3; i++) { h.advance(70_000); await h.tick(); }
    expect(h.task(CARD).machineId).toBeNull();
    expect(h.task(CARD).status).toBe("todo");
    expect(h.created).toEqual([]);
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
    await holdPastThreshold(h);
    expect(h.task(CARD).machineId).toBe(PC);
  });

  it("modello non Claude (Codex): niente Cloud, la card va sul PC", async () => {
    const h = harness();
    h.seed(CARD, { model: "codex:gpt-5.5" });
    await holdPastThreshold(h);
    expect(h.task(CARD).machineId).toBe(PC);
  });

  it("modello non Claude e PC offline: resta sul Mac", async () => {
    const h = harness({ pcOnline: false });
    h.seed(CARD, { model: "codex:gpt-5.5" });
    await holdPastThreshold(h);
    expect(h.task(CARD).machineId).toBeNull();
  });
});

describe("overflow: una card rimandata in coda dopo la review porta il suo ramo", () => {
  it("review -> todo vero, poi l'overflow su Cloud: il nodo riceve quel ramo come base", async () => {
    const h = harness();
    h.sendBack(CARD, "topics/endless-calf");
    expect(h.task(CARD).priorBranch).toBe("topics/endless-calf");
    await holdPastThreshold(h);
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

  it("un ramo già atterrato su main non fa da base: main è più nuovo", async () => {
    const h = harness({ floor: false });
    h.sendBack(CARD, "topics/endless-calf", { machineId: PC, landed: true });
    expect(h.task(CARD).priorBranch).toBeUndefined();
    await h.tick();
    expect(h.bodies).toEqual([{ originTaskId: CARD, baseBranch: undefined }]);
  });
});

describe("overflow: il modello predefinito della board", () => {
  it("board con dispatchModel Codex e card senza modello: niente Cloud, va sul PC", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { dispatchModel: "codex:gpt-5.5" });
    h.seed(CARD);
    await holdPastThreshold(h);
    expect(h.task(CARD).machineId).toBe(PC);
  });

  it("board con dispatchModel Claude: Cloud", async () => {
    const h = harness();
    h.svc.updateBoardSettings(PID, { dispatchModel: "claude-code:sonnet" });
    h.seed(CARD);
    await holdPastThreshold(h);
    expect(h.task(CARD).machineId).toBe(CLOUD);
  });
});

describe("overflow: il PC addormentato", () => {
  it("senza Cloud e con il PC addormentato ma svegliabile: la card va sul PC", async () => {
    const h = harness({ cloudCredit: false, pcOnline: false, pcWakeable: true });
    h.seed(CARD);
    await holdPastThreshold(h);
    expect(h.task(CARD).machineId).toBe(PC);
    expect(h.created).toEqual([{ baseUrl: "https://pc.local", originTaskId: CARD }]);
  });

  it("un PC offline senza nulla che lo svegli resta escluso", async () => {
    const h = harness({ cloudCredit: false, pcOnline: false, pcWakeable: false });
    h.seed(CARD);
    await holdPastThreshold(h);
    expect(h.task(CARD).machineId).toBeNull();
  });
});

describe("Cloud senza ambiente attivo sull'account", () => {
  it("la card si ferma con la causa, non resta in attesa di un nodo «che non risponde»", async () => {
    const h = harness({
      floor: false,
      createRunError: () => new CloudSetupError("nessun ambiente cloud attivo sull'account"),
    });
    h.seed(CARD, { machineId: CLOUD });
    await h.tick();
    const t = h.task(CARD);
    expect(t.status).not.toBe("todo");
    expect(t.dispatchDeferredUntil ?? null).toBeNull();
    const thread = h.svc.get(CARD)!.comments.map((c) => c.content).join("\n");
    expect(thread).toContain("nessun ambiente cloud attivo sull'account");
    expect(thread).not.toContain("non risponde");
  });

  it("un errore di rete resta un nodo muto: si riprova", async () => {
    const h = harness({ floor: false, createRunError: () => new Error("fetch failed") });
    h.seed(CARD, { machineId: CLOUD });
    await h.tick();
    expect(h.task(CARD).status).toBe("todo");
    expect(h.task(CARD).dispatchError).toBeString();
  });
});

describe("overflow: l'orologio dei 2 minuti misura una attesa ininterrotta", () => {
  it("un giro fermato da un'altra attesa (tetto di spesa) riparte da zero", async () => {
    const h = harness();
    h.seed(CARD, { costCents: 500 });
    await h.tick(); // held by memory: the clock starts
    h.advance(90_000);
    h.svc.getSpendCaps = () => ({ perTaskCents: 100, perDayCents: 0 });
    await h.tick(); // held by the spend cap, not by memory: the clock stops
    h.svc.getSpendCaps = () => ({ perTaskCents: 0, perDayCents: 0 });
    h.advance(60_000); // 150 s since the first hold, 60 s since this one
    await h.tick();
    expect(h.task(CARD).machineId).toBeNull();
    h.advance(OVERFLOW_AFTER_MS + 1_000);
    await h.tick();
    expect(h.task(CARD).machineId).toBe(CLOUD);
  });

  it("una card che esce da Todo e ci torna riparte da zero", async () => {
    const h = harness();
    h.seed(CARD);
    await h.tick();
    h.advance(90_000);
    h.db.run("UPDATE tasks SET status = 'backlog' WHERE id = ?", [CARD]);
    await h.tick();
    h.db.run("UPDATE tasks SET status = 'todo' WHERE id = ?", [CARD]);
    h.advance(60_000);
    await h.tick();
    expect(h.task(CARD).machineId).toBeNull();
    h.advance(OVERFLOW_AFTER_MS + 1_000);
    await h.tick();
    expect(h.task(CARD).machineId).toBe(CLOUD);
  });
});

describe("overflow: lo spazio sulle altre macchine", () => {
  it("un giro sposta al massimo OVERFLOW_MAX_PER_ROUND card", async () => {
    const h = harness();
    const ids = ["c-1", "c-2", "c-3"];
    for (const id of ids) h.seed(id);
    await holdPastThreshold(h);
    expect(ids.filter((id) => h.task(id).machineId === CLOUD)).toHaveLength(OVERFLOW_MAX_PER_ROUND);
    await h.tick();
    expect(ids.filter((id) => h.task(id).machineId === CLOUD)).toHaveLength(3);
  });

  it("il PC pieno ai suoi posti non prende la terza card", async () => {
    const h = harness({ cloudOnline: false });
    const ids = ["c-1", "c-2", "c-3"];
    for (const id of ids) h.seed(id);
    await holdPastThreshold(h);
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

describe("verifica del 31/10: l'orologio si azzera per ogni giro che non trattiene la card per memoria", () => {
  /** Held at 0 s, `interrupt` for one round at 90 s, held again at 150 s: the card must stay. */
  async function brokenAt150(h: ReturnType<typeof harness>, interrupt: () => void, restore: () => void) {
    h.seed(CARD);
    await h.tick(); // held by memory: the clock starts
    h.advance(90_000);
    interrupt();
    await h.tick();
    restore();
    h.advance(60_000); // 150 s since the first hold, 60 s since the interruption
    await h.tick();
    expect(h.task(CARD).machineId).toBeNull();
    h.advance(OVERFLOW_AFTER_MS + 1_000);
    await h.tick();
    expect(h.task(CARD).machineId).toBe(CLOUD);
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
    await holdPastThreshold(h);
    for (let i = 0; i < 8; i++) { h.advance(6 * 60_000); await h.tick(); }
    expect(ids.filter((id) => h.task(id).machineId === PC)).toHaveLength(OVERFLOW_SLOTS.node);
  });

  it("PC addormentato e svegliabile: la sveglia non allarga il danno", async () => {
    const h = harness({ cloudCredit: false, pcOnline: false, pcWakeable: true, createRunError: () => new Error("fetch failed") });
    const ids = ["c-1", "c-2", "c-3", "c-4", "c-5", "c-6"];
    for (const id of ids) h.seed(id);
    await holdPastThreshold(h);
    for (let i = 0; i < 8; i++) { h.advance(6 * 60_000); await h.tick(); }
    expect(ids.filter((id) => h.task(id).machineId === PC)).toHaveLength(OVERFLOW_SLOTS.node);
  });

  it("il conteggio legge le card in coda o al lavoro su quella macchina, non quelle chiuse o archiviate", () => {
    const h = harness();
    h.seed("in-coda", { machineId: PC });
    h.seed("al-lavoro", { machineId: PC });
    h.seed("chiusa", { machineId: PC });
    h.seed("archiviata", { machineId: PC });
    h.seed("altrove", { machineId: CLOUD });
    h.db.run("UPDATE tasks SET status = 'in_progress' WHERE id = 'al-lavoro'");
    h.db.run("UPDATE tasks SET status = 'done' WHERE id = 'chiusa'");
    h.db.run("UPDATE tasks SET archived = 1 WHERE id = 'archiviata'");
    expect(h.svc.countOnMachine(PC)).toBe(2);
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
    await holdPastThreshold(h);
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
    await holdPastThreshold(h);
    await h.tick();
    expect(h.task(CARD).machineId).toBeNull();
    expect(h.created).toEqual([]);
  });

  it("una card specchio (node-run:) resta sulla macchina che la esegue", async () => {
    const h = harness();
    h.seed(CARD);
    h.db.run("UPDATE tasks SET claude_task_id = 'node-run:origin-123' WHERE id = ?", [CARD]);
    await holdPastThreshold(h);
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

describe("verifica del 31/10 (terzo giro): l'orologio di una card che esce da Todo", () => {
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

  it("sola sulla board, un'ora in backlog: al rientro l'attesa riparte da zero", async () => {
    const h = harness();
    await outAndBack(h, 6);
    expect(h.task(CARD).machineId).toBeNull();
    h.advance(OVERFLOW_AFTER_MS - 10_000);
    await h.poll();
    expect(h.task(CARD).machineId).toBeNull();
    h.advance(20_000);
    await h.poll();
    expect(h.task(CARD).machineId).toBe(CLOUD);
  });

  it("sola sulla board, backlog e ritorno fra due giri: riparte da zero", async () => {
    const h = harness();
    h.seed(CARD);
    await h.poll();
    h.advance(OVERFLOW_AFTER_MS + 1_000);
    h.svc.update({ taskId: CARD, actor: "human", by: "attilio", patch: { status: "backlog" } });
    h.dispatcher.onLeaveTodo(CARD);
    h.svc.update({ taskId: CARD, actor: "human", by: "attilio", patch: { status: "todo" } });
    h.dispatcher.onEnterTodo(PID, CARD);
    await h.poll();
    expect(h.task(CARD).machineId).toBeNull();
  });

  it("uscita da Todo senza i due ganci (scrittura diretta): il primo giro senza card in coda azzera", async () => {
    const h = harness();
    h.seed(CARD);
    await h.poll();
    h.advance(10_000);
    h.db.run("UPDATE tasks SET status = 'backlog' WHERE id = ?", [CARD]);
    await h.poll();
    h.advance(OVERFLOW_AFTER_MS);
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
    await holdPastThreshold(h);
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
    await holdPastThreshold(h);
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
    await holdPastThreshold(h);
    await h.tick();
    expect(h.task(CARD).machineId).toBe(CLOUD);
  });

  it("una nuova consegna registrata qui toglie il vecchio conteggio", async () => {
    const h = harness();
    deliveredDirty(h, 3);
    h.svc.update({ taskId: CARD, actor: "human", by: "attilio", patch: { status: "todo" } });
    h.svc.recordDelivery({ taskId: CARD, branch: "topics/clean", commit: "abc1234", stat: null });
    h.db.run("UPDATE tasks SET delivery_branch = NULL, delivery_commit = NULL WHERE id = ?", [CARD]);
    await holdPastThreshold(h);
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
    await holdPastThreshold(h);
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
    await holdPastThreshold(h);
    // Choosing this Mac by hand reads as the default: the card moves anyway...
    expect(h.task(CARD).machineId).toBe(CLOUD);
    // ...so the line on the card must not say that choosing it keeps the card here.
    const note = overflowNote("Cloud Claude");
    expect(note).not.toContain("rimetti la macchina a mano");
    expect(note).toContain("«solo Mac»");
    expect(h.thread(CARD)).toContain("non basta");
  });

  it("il warm-up del pavimento non è il pavimento di memoria: oltre 2 minuti la card resta", async () => {
    const h = harness({ verdict: { ...BLOCKED, kind: "memory_warmup" } });
    h.seed(CARD);
    await holdPastThreshold(h);
    for (let i = 0; i < 3; i++) { h.advance(60_000); await h.poll(); }
    expect(h.task(CARD).machineId).toBeNull();
    expect(h.created).toHaveLength(0);
  });

  it("l'orologio si azzera con l'auto-dispatch spento in mezzo", async () => {
    const h = harness();
    h.seed(CARD);
    await h.poll();
    h.advance(90_000);
    h.svc.updateBoardSettings(PID, { autoDispatch: false });
    await h.poll();
    h.svc.updateBoardSettings(PID, { autoDispatch: true });
    h.advance(60_000); // 150 s since the first hold, 60 s since the switch came back on
    await h.poll();
    expect(h.task(CARD).machineId).toBeNull();
    h.advance(OVERFLOW_AFTER_MS + 1_000);
    await h.poll();
    expect(h.task(CARD).machineId).toBe(CLOUD);
  });

  it("l'orologio si azzera anche con la board in pausa in mezzo", async () => {
    const h = harness();
    h.seed(CARD);
    await h.poll();
    h.advance(90_000);
    h.svc.updateBoardSettings(PID, { dispatchPaused: true });
    await h.poll();
    h.svc.updateBoardSettings(PID, { dispatchPaused: false });
    h.advance(60_000);
    await h.poll();
    expect(h.task(CARD).machineId).toBeNull();
    h.advance(OVERFLOW_AFTER_MS + 1_000);
    await h.poll();
    expect(h.task(CARD).machineId).toBe(CLOUD);
  });
});
