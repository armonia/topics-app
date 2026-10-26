/**
 * THE GATES OF THIS MACHINE HOLD ONLY THE CARDS THAT RUN ON IT.
 *
 * A card whose `machine_id` names a paired node or Cloud Claude is launched
 * over there (`remoteLaunch`): no worktree, no topic, no process here. On
 * 26/10 the Mac sat at 4.2 GB under a 6 GB floor and every card of the board
 * waited, the ones assigned to Cloud Claude included: the runtime added to
 * take the load off the Mac was held by the Mac's own memory.
 *
 * The contract, one clause per gate:
 *  1. the memory floor holds the local card and launches the remote one; a
 *     FULL DISK holds both (the remote delivery is planted in this checkout);
 *  2. the resources budget holds the local queue, not the remote cards;
 *  3. the ramp: a remote start does not move it, and a local start a moment
 *     ago does not hold a remote card;
 *  4. a heavy LOCAL turn in flight holds the local queue, not the remote card;
 *  5. an external session on an IN-PLACE board holds the local queue only;
 *  6. a remote card in flight counts on no local census: not as a heavy turn,
 *     not on the count cap, and not while its node is still answering;
 *  7. what does hold a remote card: the day spend brake;
 *  8. a machine row with no address (a stale row of this Mac) is local for
 *     every gate, as it is for the SQL census.
 * The control in every case is a local card beside the remote one.
 *
 * @covers KANBAN-76
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import type { MachineBudgetSample } from "../../shared/board";
import { createTaskService, type TaskService } from "./tasks";
import { createTaskDispatcher, type DispatcherDeps } from "./task-dispatcher";
import type { MemoryFloorHold, ResourceFloorVerdict } from "./dispatch-capacity";
import type { TurnEndInfo } from "../providers/stop-reason";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL, APP_SETTINGS_DDL } from "../db/test-schema";

const PID = "alpha-abc123";
const CLOUD = "cloud-claude";
const LOCAL = "questa-macchina";
/** A row this Mac left behind under an old hostname: no address. */
const STALE = "vecchio-hostname";

const MEMORY: ResourceFloorVerdict = {
  reason: "Memoria quasi finita: 4.2 GB disponibili, sotto il pavimento di 6 GB.",
  kind: "memory",
  memoryFirstCardExempt: false,
};
const DISK: ResourceFloorVerdict = {
  reason: "Disco quasi pieno: 2 GB liberi, sotto il pavimento.",
  kind: "disk",
  memoryFirstCardExempt: false,
};
const OPEN: ResourceFloorVerdict = { reason: null, kind: null, memoryFirstCardExempt: false };

/** Twelve cores, and Topics already over a 50% budget: nothing local fits. */
const OVER_BUDGET: MachineBudgetSample = {
  cores: 12, totalMemGB: 32, ourCoreUnits: 5.8, otherCoreUnits: 1,
  ourMemGB: 3, availableMemGB: 20, running: 2,
};
const QUIET: MachineBudgetSample = {
  cores: 12, totalMemGB: 32, ourCoreUnits: 0, otherCoreUnits: 1,
  ourMemGB: 0, availableMemGB: 20, running: 0,
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
    dispatch_idle_min INTEGER NOT NULL DEFAULT 5,
    dispatch_mcp TEXT,
    dispatch_retry_cap INTEGER, dispatch_retry_backoff_s INTEGER,
    review_checks TEXT,
    max_agents_auto INTEGER, dispatch_fanout INTEGER,
    dispatch_paused INTEGER NOT NULL DEFAULT 0,
    max_agents_mode TEXT, max_load_ratio REAL, max_mem_ratio REAL,
    machine_budget_share REAL,
    agent_cost_cap_cents INTEGER NOT NULL DEFAULT 0,
    agent_cost_cap_cents_24h INTEGER NOT NULL DEFAULT 0
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
  db.run(APP_SETTINGS_DDL);
  db.run("UPDATE app_settings SET auto_dispatch = 1 WHERE id = 1");
  // Cloud Claude has an address, as in production (`claude-cloud://`); this
  // Mac's own rows have none.
  db.run("INSERT INTO machines (id, base_url) VALUES (?, 'claude-cloud://')", [CLOUD]);
  db.run("INSERT INTO machines (id) VALUES (?)", [LOCAL]);
  db.run("INSERT INTO machines (id) VALUES (?)", [STALE]);
  return db;
}

interface HarnessOptions {
  floor?: ResourceFloorVerdict;
  budget?: MachineBudgetSample;
  /** `createRun` that never answers: the node is still thinking. */
  silentNode?: boolean;
  intruder?: boolean;
}

function harness(o: HarnessOptions = {}) {
  const db = freshDb();
  const svc: TaskService = createTaskService(db);
  const created: string[] = [];
  const turns: string[] = [];
  const readings: MemoryFloorHold[] = [];
  let nextRun = 0;
  const deps: DispatcherDeps = {
    svc,
    resolveProject: () => ({ path: "/tmp/alpha", projectStoreId: "store-1" }),
    createTopic: () => {
      const id = `topic-${turns.length + 1}`;
      db.run("INSERT OR IGNORE INTO topics (id) VALUES (?)", [id]);
      return { topicId: id, sessionKey: `topic:${id}` };
    },
    createWorktree: async () => "wt",
    deleteWorktree: async () => {},
    // Never settles: a local turn that started stays in flight.
    runTurn: (sessionKey) => { turns.push(sessionKey); return new Promise<TurnEndInfo | void>(() => {}); },
    broadcast: () => {},
    resourceBlock: (hold) => { readings.push({ ...hold }); return o.floor ?? OPEN; },
    ...(o.budget ? { budgetSample: () => o.budget!, agentCostSamples: () => [1, 1, 1] } : {}),
    ...(o.intruder ? { externalSessionsAt: () => [{ cwd: "/tmp/alpha", branch: "main" }] } : {}),
    node: {
      createRun: ({ body }) => {
        created.push((body as { originTaskId: string }).originTaskId);
        if (o.silentNode) return new Promise<{ runId: string }>(() => {});
        nextRun += 1;
        return Promise.resolve({ runId: `run-${nextRun}` });
      },
      readRun: async () => ({
        status: "in_progress", dispatchState: "working", dispatchError: null, comments: [],
        deliveryBranch: null, deliveryCommit: null, baseSha: null, stat: null,
      }),
      fetchBundle: async () => ({ empty: true as const }),
      cancelRun: async () => {},
      baseUrlOf: (id) => (id === CLOUD ? "claude-cloud://" : null),
      tokenOf: () => "tok-cloud",
      nameOf: () => "Cloud Claude",
      localMachineId: () => LOCAL,
      originUrlOf: async () => "git@github.com:acme/alpha.git",
      plantBranch: async () => ({ planted: true, commit: "c0ffeec0ffee", reason: null }),
    },
    graceMs: 0,
    retryBackoffMs: 0,
    log: () => {},
  };
  const dispatcher = createTaskDispatcher(deps);
  svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: !o.intruder, dispatchFanOut: 1 });
  svc.setGlobalCap({ auto: false, max: 9 });

  let seq = 0;
  const seed = (id: string, machineId: string | null, extra: { status?: string; weight?: string; state?: string } = {}) => {
    const ts = new Date(Date.UTC(2026, 9, 26, 15, 0, seq++)).toISOString();
    db.run(
      `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, dispatch_attempts, machine_id, dispatch_weight, dispatch_state)
       VALUES (?, ?, 'una card in coda', ?, ?, ?, 0, ?, ?, ?)`,
      [id, PID, extra.status ?? "todo", ts, ts, machineId, extra.weight ?? null, extra.state ?? null],
    );
  };
  return { db, svc, dispatcher, created, turns, readings, seed, task: (id: string) => svc.get(id)!.task };
}

const flush = async (n = 12) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};
async function dispatch(h: ReturnType<typeof harness>) {
  await h.dispatcher.tick(PID);
  await flush();
}

describe("i cancelli del Mac trattengono solo le card che girano sul Mac", () => {
  it("il pavimento di memoria ferma la card locale e lascia partire quella cloud", async () => {
    const h = harness({ floor: MEMORY });
    h.seed("locale", LOCAL);
    h.seed("cloud", CLOUD);

    await dispatch(h);

    expect(h.created).toEqual(["cloud"]);
    expect(h.task("cloud").status).toBe("in_progress");
    expect(h.task("cloud").dispatchState).toBe("working");
    // The control: the same floor still holds the card that would run here.
    expect(h.task("locale").status).toBe("todo");
    expect(h.turns).toEqual([]);
  });

  it("il disco pieno ferma anche la card cloud: la sua consegna si pianta in questo checkout", async () => {
    const h = harness({ floor: DISK });
    h.seed("locale", null);
    h.seed("cloud", CLOUD);

    await dispatch(h);

    expect(h.created).toEqual([]);
    expect(h.task("cloud").status).toBe("todo");
    expect(h.task("locale").status).toBe("todo");
  });

  it("il budget per risorse ferma la coda locale, non le card cloud", async () => {
    const h = harness({ budget: OVER_BUDGET });
    h.svc.setGlobalCap({ auto: false, max: 4, mode: "resources", budgetShare: 0.5 });
    h.seed("locale", null);
    h.seed("cloud-1", CLOUD);
    h.seed("cloud-2", CLOUD);

    await dispatch(h);

    expect(h.created).toEqual(["cloud-1", "cloud-2"]);
    expect(h.task("locale").status).toBe("todo");
    expect(h.turns).toEqual([]);
  });

  it("la rampa: una partenza cloud non la sposta, e una locale appena partita non ferma la cloud", async () => {
    const h = harness({ budget: QUIET });
    h.svc.setGlobalCap({ auto: false, max: 4, mode: "resources", budgetShare: 0.8 });
    h.seed("cloud-1", CLOUD);
    h.seed("cloud-2", CLOUD);
    h.seed("locale-1", null);

    await dispatch(h);

    // Two cloud starts in one pass, and the local card behind them still finds
    // the ramp open: neither cloud start moved it.
    expect(h.created).toEqual(["cloud-1", "cloud-2"]);
    expect(h.task("locale-1").status).toBe("in_progress");

    // A moment later the local start holds the ramp: a second local card waits
    // (the control), a new cloud card does not.
    h.seed("locale-2", null);
    h.seed("cloud-3", CLOUD);
    await dispatch(h);

    expect(h.created).toEqual(["cloud-1", "cloud-2", "cloud-3"]);
    expect(h.task("locale-2").status).toBe("todo");
  });

  it("un pesante locale in volo ferma la coda locale, non la card cloud", async () => {
    const h = harness();
    h.seed("pesante", LOCAL, { status: "in_progress", weight: "heavy", state: "working" });
    h.seed("locale", null);
    h.seed("cloud", CLOUD);

    await dispatch(h);

    expect(h.created).toEqual(["cloud"]);
    expect(h.task("locale").status).toBe("todo");
  });

  it("una sessione esterna su una board in-place ferma la coda locale, non la card cloud", async () => {
    const h = harness({ intruder: true });
    h.seed("locale", null);
    h.seed("cloud", CLOUD);

    await dispatch(h);

    expect(h.created).toEqual(["cloud"]);
    expect(h.task("locale").status).toBe("todo");
  });

  it("una card cloud in volo non pesa sul censimento locale: né come pesante né sul tetto", async () => {
    const h = harness({ budget: QUIET });
    h.svc.setGlobalCap({ auto: false, max: 1 });
    // A heavy card working on Cloud Claude, and a cap of one agent on this Mac.
    h.seed("cloud-pesante", CLOUD, { status: "in_progress", weight: "heavy", state: "working" });
    h.seed("locale", null);

    await dispatch(h);

    expect(h.svc.liveAgents()).toBe(1);
    expect(h.task("locale").status).toBe("in_progress");
    expect(h.turns).toHaveLength(1);
  });

  it("mentre il nodo non ha ancora risposto la corsa non conta come turno di questa macchina", async () => {
    const h = harness({ silentNode: true });
    h.seed("cloud", CLOUD);

    await dispatch(h);
    // The run exists here, waiting for the node to name it ...
    expect(h.created).toEqual(["cloud"]);
    expect(h.dispatcher.busyIds()).toContain("cloud");
    // ... and no local census charges it: not the cap, not the floor.
    expect(h.dispatcher.busyCount()).toBe(0);
    h.readings.length = 0;
    await dispatch(h);
    expect(h.readings.length).toBeGreaterThan(0);
    for (const r of h.readings) expect(r).toMatchObject({ ourWorkRunning: false, spendingHere: false });
  });

  it("il freno di spesa del giorno ferma anche la card cloud", async () => {
    const h = harness();
    h.svc.setSpendCaps({ perDayCents: 50_000 });
    h.seed("spesa", null, { status: "review" });
    h.svc.raiseAgentUsage({ taskId: "spesa", tokens: 10, cacheReadTokens: 0, costCents: 60_000 });
    h.seed("cloud", CLOUD);

    await dispatch(h);

    expect(h.created).toEqual([]);
    expect(h.task("cloud").status).toBe("todo");
  });

  it("una riga senza indirizzo (un vecchio hostname di questo Mac) è locale per ogni cancello", async () => {
    const h = harness({ floor: MEMORY });
    h.seed("vecchia-riga", STALE);

    await dispatch(h);

    // Held by the floor like any local card: it never reaches the remote lane,
    // which would claim it and bounce it back as an unreachable node.
    expect(h.created).toEqual([]);
    expect(h.task("vecchia-riga").status).toBe("todo");
    expect(h.task("vecchia-riga").dispatchState).toBe("queued");
    expect(h.task("vecchia-riga").dispatchAttempts).toBe(0);
    expect(h.svc.get("vecchia-riga")!.comments).toEqual([]);
  });
});
