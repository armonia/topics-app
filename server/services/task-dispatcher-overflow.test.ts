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
 *  4. the board switch off: nothing moves.
 *
 * Harness: the node fake and the injected floor of
 * `task-dispatcher-remote-node-floor.test.ts`, with a clock the test moves.
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { createTaskService, type TaskService } from "./tasks";
import { createTaskDispatcher, type DispatcherDeps } from "./task-dispatcher";
import type { ResourceFloorVerdict } from "./dispatch-capacity";
import type { TurnEndInfo } from "../providers/stop-reason";
import { OVERFLOW_AFTER_MS, overflowEligible, pickOverflowMachine, type OverflowMachine } from "./dispatch-overflow";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL } from "../db/test-schema";

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
    max_agents_auto INTEGER, dispatch_fanout INTEGER,
    dispatch_overflow INTEGER NOT NULL DEFAULT 1, dispatch_stay_local INTEGER NOT NULL DEFAULT 0
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

function harness(opts: { cloudOnline?: boolean; pcOnline?: boolean; cloudCredit?: boolean } = {}) {
  const db = freshDb();
  const svc: TaskService = createTaskService(db);
  const created: Array<{ baseUrl: string; originTaskId: string }> = [];
  const turns: string[] = [];
  let now = Date.UTC(2026, 9, 30, 10, 0, 0);
  let nextRun = 0;
  const machines = (): OverflowMachine[] => [
    { id: CLOUD, name: NAME[CLOUD], kind: "cloud", online: opts.cloudOnline ?? true },
    { id: PC, name: NAME[PC], kind: "node", online: opts.pcOnline ?? true },
  ];

  const deps: DispatcherDeps = {
    svc,
    resolveProject: () => ({ path: "/tmp/alpha", projectStoreId: "store-1" }),
    createTopic: () => {
      const id = `topic-${turns.length + 1}`;
      db.run("INSERT OR IGNORE INTO topics (id) VALUES (?)", [id]);
      return { topicId: id, sessionKey: `topic:${id}` };
    },
    createWorktree: async () => "wt-1",
    deleteWorktree: async () => {},
    runTurn: (sessionKey) => { turns.push(sessionKey); return new Promise<TurnEndInfo | void>(() => {}); },
    broadcast: () => {},
    // The Mac stays under its floor for the whole test: only a move gets the card out.
    resourceBlock: () => BLOCKED,
    node: {
      createRun: async ({ baseUrl, body }) => {
        created.push({ baseUrl, originTaskId: body.originTaskId });
        nextRun += 1;
        return { runId: `run-${nextRun}` };
      },
      readRun: async () => ({
        status: "in_progress", dispatchState: "working", dispatchError: null, comments: [],
        deliveryBranch: null, deliveryCommit: null, baseSha: null, stat: null,
      }),
      fetchBundle: async () => ({ empty: true as const }),
      cancelRun: async () => {},
      baseUrlOf: (id) => ADDRESS[id] ?? null,
      tokenOf: () => "tok",
      nameOf: (id) => NAME[id] ?? null,
      localMachineId: () => LOCAL,
      originUrlOf: async () => "git@github.com:acme/alpha.git",
      plantBranch: async () => ({ planted: true, commit: "c0ffeec0ffee", reason: null }),
    },
    overflowMachines: machines,
    cloudCredit: () => opts.cloudCredit ?? true,
    now: () => now,
    graceMs: 0,
    retryBackoffMs: 0,
    log: () => {},
  };
  const dispatcher = createTaskDispatcher(deps);
  svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: true, dispatchFanOut: 1 });
  svc.setGlobalCap({ auto: false, max: 9 });

  const seed = (id: string, extra: { machineId?: string | null; stayLocal?: boolean } = {}) => {
    const ts = new Date(now).toISOString();
    db.run(
      `INSERT INTO tasks (id, project_id, text, description, status, created_at, updated_at, dispatch_attempts, machine_id, stay_local)
       VALUES (?, ?, 'una card in coda', 'sotto il pavimento', 'todo', ?, ?, 0, ?, ?)`,
      [id, PID, ts, ts, extra.machineId ?? null, extra.stayLocal ? 1 : 0],
    );
  };
  const flush = async (n = 12) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
  const tick = async () => { await dispatcher.tick(PID); await flush(); };
  const advance = (ms: number) => { now += ms; };
  return { svc, created, turns, seed, tick, advance, task: (id: string) => svc.get(id)!.task };
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

describe("overflow: le due regole pure", () => {
  const m = (id: string, kind: "cloud" | "node", online: boolean): OverflowMachine => ({ id, name: id, kind, online });

  it("Cloud con credito prima, poi il primo nodo online", () => {
    expect(pickOverflowMachine([m("pc", "node", true), m("cloud", "cloud", true)], { cloudCredit: true })?.id).toBe("cloud");
    expect(pickOverflowMachine([m("pc", "node", true), m("cloud", "cloud", true)], { cloudCredit: false })?.id).toBe("pc");
    expect(pickOverflowMachine([m("pc", "node", false), m("cloud", "cloud", false)], { cloudCredit: true })).toBeNull();
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
