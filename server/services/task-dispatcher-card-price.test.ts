/**
 * A CARD IS HELD BY THE MEMORY LINE OF ITS OWN BOARD.
 *
 * 26/10/2026: ~7 GB free, a floor of 6, and the board `attilio` (in place, no
 * local check) stood still for hours behind a line of 6 + 4 + reservation. The
 * 4 was the floor of an empty price list, a figure no card of that board ever
 * reaches. The line is now drawn with the price of the board the card belongs
 * to (`dispatch-card-price.ts`), and these are the contracts of that:
 *
 *  1. a light board (in place, no local check) starts a second card where the
 *     flat line would hold it, and a repo board (worktree) does not;
 *  2. the light line is exactly floor + price + one price per turn in flight:
 *     under it the card waits, and each start raises it for the next card of
 *     the SAME pass;
 *  3. the reservation is per turn at the price of ITS board, so a repo card
 *     is not charged four for the light turn beside it;
 *  4. only memory is lifted: a full disk and the day spend brake still hold
 *     the light card;
 *  5. the cap by resources asks the same question with the same price;
 *  6. the queue snapshot and the capacity preview speak with the board's price.
 *
 * The floor is the real `dispatchResourceVerdict` on a native machine (6 GB),
 * fed an injected two-minute reading.
 *
 * @covers KANBAN-75
 */
import { afterEach, describe, it, expect, setSystemTime } from "bun:test";
import { Database } from "bun:sqlite";
import type { MachineBudgetSample, ReviewCheck } from "../../shared/board";
import { createTaskService, type TaskService } from "./tasks";
import { setActiveBudgetGovernor, type BudgetGovernor } from "./budget-governor";
import { createTaskDispatcher, type DispatcherDeps } from "./task-dispatcher";
import { dispatchResourceVerdict, type MemoryFloorHold } from "./dispatch-capacity";
import type { TurnEndInfo } from "../providers/stop-reason";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL, APP_SETTINGS_DDL } from "../db/test-schema";

/** In place and no local check: the light class. */
const QUIET = "quiet-board";
/** A worktree board: the standard class. */
const REPO = "repo-board";
const LOCAL_CHECK: ReviewCheck = { name: "unit", cmd: "bun test" };

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
  return db;
}

afterEach(() => setSystemTime());

interface HarnessOptions {
  /** The lowest memory reading of the last two minutes, in GB. */
  held: number;
  /** The machine sample the cap by resources reads; count mode when absent. */
  budget?: MachineBudgetSample;
  /** Check commands of the repo board; none by default. */
  repoChecks?: ReviewCheck[];
  /** The probe of a delivery commit: a card that carries one parks on it. */
  deliveryLanded?: DispatcherDeps["deliveryLanded"];
}

function harness(o: HarnessOptions) {
  const db = freshDb();
  const svc: TaskService = createTaskService(db);
  const turns: string[] = [];
  const ends = new Map<string, () => void>();
  const holds: MemoryFloorHold[] = [];
  let held = o.held;
  let disk = 500;
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
    topicExists: () => true,
    // Settles only through `endTurn`: a local turn that started stays in flight.
    runTurn: (sessionKey) => { turns.push(sessionKey); return new Promise<TurnEndInfo | void>((r) => { ends.set(sessionKey, () => r()); }); },
    broadcast: () => {},
    // The real floor of a native machine, with the window already full.
    resourceBlock: (hold) => {
      holds.push({ ...hold });
      return dispatchResourceVerdict(
        "/tmp", () => disk,
        () => ({ measurable: true, latestGB: held, heldGB: held, coveredMs: 120_000 }),
        false, hold,
      );
    },
    ...(o.deliveryLanded ? { deliveryLanded: o.deliveryLanded } : {}),
    ...(o.budget ? { budgetSample: () => o.budget!, agentCostSamples: () => [1, 1, 1] } : {}),
    graceMs: 0,
    retryBackoffMs: 0,
    log: () => {},
  };
  const dispatcher = createTaskDispatcher(deps);
  svc.updateBoardSettings(QUIET, { autoDispatch: true, dispatchUseWorktree: false, reviewChecks: [], dispatchFanOut: 1 });
  svc.updateBoardSettings(REPO, { autoDispatch: true, dispatchUseWorktree: true, reviewChecks: o.repoChecks ?? [], dispatchFanOut: 1 });
  svc.setGlobalCap({ auto: false, max: 9 });

  let seq = 0;
  const seed = (id: string, projectId: string) => {
    const ts = new Date(Date.UTC(2026, 9, 26, 15, 0, seq++)).toISOString();
    db.run(
      `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, dispatch_attempts)
       VALUES (?, ?, 'una card in coda', 'todo', ?, ?, 0)`,
      [id, projectId, ts, ts],
    );
  };
  /** A card the turn of which was cut, bound to its topic and waiting to be resumed. */
  const park = (id: string, projectId: string) => {
    const ts = new Date(Date.UTC(2026, 9, 26, 14, 0, seq++)).toISOString();
    db.run("INSERT OR IGNORE INTO topics (id) VALUES (?)", [`topic-${id}`]);
    db.run(
      `INSERT INTO tasks (id, project_id, text, status, assigned_topic_id, created_at, updated_at, dispatch_attempts)
       VALUES (?, ?, 'una card parcheggiata', 'in_progress', ?, ?, ?, 1)`,
      [id, projectId, `topic-${id}`, ts, ts],
    );
  };
  const flush = async (n = 12) => {
    for (let i = 0; i < n; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  };
  return {
    db, svc, dispatcher, turns, holds, seed, park,
    setHeld: (gb: number) => { held = gb; },
    /** The card delivered: its turn ends with the card in review, so nothing resumes it. */
    async endTurn(id: string) {
      const sessionKey = `topic:${svc.get(id)!.task.assignedTopicId}`;
      db.run("UPDATE tasks SET status = 'review' WHERE id = ?", [id]);
      ends.get(sessionKey)?.();
      await flush();
    },
    setDisk: (gb: number) => { disk = gb; },
    task: (id: string) => svc.get(id)!.task,
    flush,
    async dispatch(projectId: string) {
      await dispatcher.tick(projectId);
      await flush();
    },
  };
}

/** The by-resources mode spaces two starts by nine seconds; the test lets them pass. */
const pastTheRamp = () => setSystemTime(new Date(Date.now() + 10_000));

/** One light turn already in flight, the state the production queue is in. */
async function withOneQuietTurn(o: HarnessOptions) {
  const h = harness(o);
  h.seed("first", QUIET);
  await h.dispatch(QUIET);
  expect(h.turns).toHaveLength(1);
  return h;
}

describe("la riga di memoria è quella della board della card", () => {
  it("una board in place senza check parte accanto a un turno in volo, dove la riga piatta la terrebbe ferma", async () => {
    // Flat line: 6 + 4 + 4 = 14 GB. Light line: 6 + 1 + 1 = 8 GB.
    const h = await withOneQuietTurn({ held: 8.5 });
    h.seed("second", QUIET);

    await h.dispatch(QUIET);

    expect(h.task("second").status).toBe("in_progress");
    expect(h.turns).toHaveLength(2);
  });

  it("il controllo: una board con worktree, alla stessa lettura, resta ferma sulla riga da 14 GB", async () => {
    const h = harness({ held: 8.5 });
    h.seed("first", REPO);
    await h.dispatch(REPO);
    expect(h.turns).toHaveLength(1);
    h.seed("second", REPO);

    await h.dispatch(REPO);

    expect(h.task("second").status).toBe("todo");
    expect(h.task("second").dispatchState).toBe("queued");
    expect(h.turns).toHaveLength(1);
    // The sentence the machine writes is the standard card's line.
    expect(h.dispatcher.admissionPreview?.(REPO)?.reason).toContain("14.0 GB");
  });

  it("una board in place con un check locale è standard: il check gira su questa macchina", async () => {
    const h = harness({ held: 8.5, repoChecks: [LOCAL_CHECK] });
    h.svc.updateBoardSettings(REPO, { dispatchUseWorktree: false });
    h.seed("first", REPO);
    await h.dispatch(REPO);
    h.seed("second", REPO);

    await h.dispatch(REPO);

    expect(h.task("second").status).toBe("todo");
    expect(h.turns).toHaveLength(1);
  });

  it("sotto la sua riga (6 + 1 + 1 = 8 GB) la card leggera aspetta come le altre", async () => {
    const h = await withOneQuietTurn({ held: 7.9 });
    h.seed("second", QUIET);

    await h.dispatch(QUIET);

    expect(h.task("second").status).toBe("todo");
    expect(h.turns).toHaveLength(1);

    // On the line itself it starts: the comparison is "at or above".
    h.setHeld(8);
    await h.dispatch(QUIET);

    expect(h.task("second").status).toBe("in_progress");
    expect(h.turns).toHaveLength(2);
  });

  it("ogni partenza alza la riga per la card dopo, anche nello stesso giro", async () => {
    // Lines for the 2nd, 3rd and 4th card: 8, 9 and 10 GB. At 9.5 two start in
    // one pass (the second one past the flat re-read that follows a start), and
    // the third waits.
    const h = await withOneQuietTurn({ held: 9.5 });
    h.seed("second", QUIET);
    h.seed("third", QUIET);
    h.seed("fourth", QUIET);

    await h.dispatch(QUIET);

    expect(h.turns).toHaveLength(3);
    expect(h.task("second").status).toBe("in_progress");
    expect(h.task("third").status).toBe("in_progress");
    expect(h.task("fourth").status).toBe("todo");
  });

  it("la prenotazione è per turno, al prezzo della sua board: una card con worktree non paga quattro per il turno leggero", async () => {
    // Quiet turn in flight, a repo card asks: 6 + 4 (its own price) + 1 (the
    // light turn) = 11 GB, and not 6 + 4 + 4 = 14.
    const h = await withOneQuietTurn({ held: 11.5 });
    h.seed("repo-card", REPO);

    await h.dispatch(REPO);

    expect(h.task("repo-card").status).toBe("in_progress");

    // The control, a notch under the line: held.
    const g = await withOneQuietTurn({ held: 10.9 });
    g.seed("repo-card", REPO);
    await g.dispatch(REPO);
    expect(g.task("repo-card").status).toBe("todo");
  });
});

describe("la riga della card leggera alleggerisce solo la memoria", () => {
  it("card 10469e3e: un check congelato tiene ferma anche la card leggera, sotto il pavimento di memoria", async () => {
    setActiveBudgetGovernor({ frozenCount: () => 1 } as unknown as BudgetGovernor);
    try {
      const roomy: MachineBudgetSample = {
        cores: 12, totalMemGB: 32, ourCoreUnits: 0.5, otherCoreUnits: 1,
        ourMemGB: 1, availableMemGB: 30, running: 1,
      };
      const h = await withOneQuietTurn({ held: 8.5, budget: roomy });
      pastTheRamp();
      h.svc.setGlobalCap({ auto: false, max: 4, mode: "resources", budgetShare: 0.8 });
      h.seed("second", QUIET);
      await h.dispatch(QUIET);
      expect(h.task("second").status).toBe("todo");
    } finally { setActiveBudgetGovernor(null); }
  });

  it("card 10469e3e: un check congelato tiene ferma anche la card leggera, sotto la pressione del tetto per risorse", async () => {
    const sample: MachineBudgetSample = {
      cores: 12, totalMemGB: 32, ourCoreUnits: 0.5, otherCoreUnits: 1,
      ourMemGB: 1, availableMemGB: 5, running: 1,
    };
    setActiveBudgetGovernor({ frozenCount: () => 1 } as unknown as BudgetGovernor);
    try {
      const h = await withOneQuietTurn({ held: 20, budget: sample });
      pastTheRamp();
      h.svc.setGlobalCap({ auto: false, max: 4, mode: "resources", budgetShare: 0.8 });
      h.seed("second", QUIET);
      await h.dispatch(QUIET);
      expect(h.task("second").status).toBe("todo");
    } finally { setActiveBudgetGovernor(null); }
  });

  it("un disco quasi pieno tiene ferma anche la card leggera", async () => {
    const h = await withOneQuietTurn({ held: 20 });
    h.setDisk(1);
    h.seed("second", QUIET);

    await h.dispatch(QUIET);

    expect(h.task("second").status).toBe("todo");
    expect(h.turns).toHaveLength(1);
  });

  it("il freno di spesa del giorno tiene ferma la card leggera, anche con la memoria libera alla sua riga", async () => {
    const h = await withOneQuietTurn({ held: 8.5 });
    h.svc.setSpendCaps({ perDayCents: 50_000 });
    h.seed("spesa", REPO);
    h.db.run("UPDATE tasks SET status = 'review' WHERE id = 'spesa'");
    h.svc.raiseAgentUsage({ taskId: "spesa", tokens: 10, cacheReadTokens: 0, costCents: 60_000 });
    h.seed("second", QUIET);

    await h.dispatch(QUIET);

    expect(h.task("second").status).toBe("todo");
    expect(h.turns).toHaveLength(1);
  });

  it("il tetto per risorse ripete la domanda con lo stesso prezzo: 5 GB liberi bastano a una card leggera, non a una da 4", async () => {
    // Quota of free memory = 0.8 x (5 - 1 reserved) = 3.2 GB: more than the
    // light price (1), less than the standard (4). The floor is wide open.
    const sample: MachineBudgetSample = {
      cores: 12, totalMemGB: 32, ourCoreUnits: 0.5, otherCoreUnits: 1,
      ourMemGB: 1, availableMemGB: 5, running: 1,
    };
    const light = await withOneQuietTurn({ held: 20, budget: sample });
    pastTheRamp();
    light.svc.setGlobalCap({ auto: false, max: 4, mode: "resources", budgetShare: 0.8 });
    light.seed("second", QUIET);
    await light.dispatch(QUIET);
    expect(light.task("second").status).toBe("in_progress");

    const repo = await withOneQuietTurn({ held: 20, budget: sample });
    pastTheRamp();
    repo.svc.setGlobalCap({ auto: false, max: 4, mode: "resources", budgetShare: 0.8 });
    repo.seed("second", REPO);
    await repo.dispatch(REPO);
    expect(repo.task("second").status).toBe("todo");
  });

  it("un tetto per risorse che non lascia posto nemmeno al prezzo leggero tiene ferma anche la card leggera", async () => {
    // Quota = 0.8 x (2 - 1 reserved) = 0.8 GB, under the light price (1).
    const sample: MachineBudgetSample = {
      cores: 12, totalMemGB: 32, ourCoreUnits: 0.5, otherCoreUnits: 1,
      ourMemGB: 1, availableMemGB: 2, running: 1,
    };
    const h = await withOneQuietTurn({ held: 20, budget: sample });
    pastTheRamp();
    h.svc.setGlobalCap({ auto: false, max: 4, mode: "resources", budgetShare: 0.8 });
    h.seed("second", QUIET);

    await h.dispatch(QUIET);

    expect(h.task("second").status).toBe("todo");
    expect(h.turns).toHaveLength(1);
  });

  it("la CPU sopra il budget tiene ferma la card leggera, isteresi compresa", async () => {
    // Usable cores 8.8. Over the line the gate holds; it resumes only under 80%
    // of it (7.04). The second tick reads 7.5: under the line, over the resume
    // point, so the light card must still wait like every other.
    const sample: MachineBudgetSample = {
      cores: 12, totalMemGB: 32, ourCoreUnits: 8.5, otherCoreUnits: 1,
      ourMemGB: 1, availableMemGB: 20, running: 1,
    };
    const h = await withOneQuietTurn({ held: 20, budget: sample });
    pastTheRamp();
    h.svc.setGlobalCap({ auto: false, max: 4, mode: "resources", budgetShare: 0.8 });
    h.seed("second", QUIET);

    await h.dispatch(QUIET);
    expect(h.task("second").status).toBe("todo");

    sample.ourCoreUnits = 5.5;
    await h.dispatch(QUIET);

    expect(h.dispatcher.admissionPreview?.(QUIET)?.usedCoreUnits).toBeGreaterThan(6);
    expect(h.task("second").status).toBe("todo");
    expect(h.turns).toHaveLength(1);
  });
});

describe("la riga si rilegge subito prima della partenza", () => {
  /** A probe that answers when the test says so: the awaited gap of a delivered card. */
  function parkedProbe() {
    let release: ((landed: boolean | null) => void) | null = null;
    return {
      deliveryLanded: () => new Promise<boolean | null>((r) => { release = r; }),
      isParked: () => release !== null,
      answer: (landed: boolean | null) => release!(landed),
    };
  }
  const waitForProbe = async (probe: ReturnType<typeof parkedProbe>) => {
    for (let i = 0; i < 50 && !probe.isParked(); i++) await Promise.resolve();
  };

  it("un disco che si riempie mentre la card aspetta la sonda la tiene ferma, anche dopo una partenza dello stesso giro", async () => {
    // Lines: 8 GB for the 2nd card, 9 for the 3rd. At 9.5 both fit.
    const probe = parkedProbe();
    const h = await withOneQuietTurn({ held: 9.5, deliveryLanded: probe.deliveryLanded });
    h.seed("plain", QUIET);
    h.seed("delivered", QUIET);
    h.db.run("UPDATE tasks SET delivery_commit = 'abc1234def5678' WHERE id = 'delivered'");

    // `plain` starts, `delivered` parks on the probe with its light pass in hand.
    const tick = h.dispatcher.tick(QUIET);
    await waitForProbe(probe);
    expect(probe.isParked()).toBe(true);
    expect(h.turns).toHaveLength(2);

    h.setDisk(1);
    probe.answer(false);
    await tick;
    await h.flush();

    expect(h.task("delivered").status).toBe("todo");
    expect(h.turns).toHaveLength(2);
  });

  it("una card partita su un'altra board mentre la sonda risponde alza la riga: la seconda non parte contro una lettura che ne ammette una", async () => {
    // One light turn in flight, 8.5 GB: one more fits (line 8), two do not (line 9).
    const probe = parkedProbe();
    const h = await withOneQuietTurn({ held: 8.5, deliveryLanded: probe.deliveryLanded });
    h.svc.updateBoardSettings("other-quiet", { autoDispatch: true, dispatchUseWorktree: false, reviewChecks: [], dispatchFanOut: 1 });
    h.seed("delivered", QUIET);
    h.db.run("UPDATE tasks SET delivery_commit = 'abc1234def5678' WHERE id = 'delivered'");
    h.seed("other", "other-quiet");

    const first = h.dispatcher.tick(QUIET);
    await waitForProbe(probe);
    expect(probe.isParked()).toBe(true);
    await h.dispatch("other-quiet");
    expect(h.task("other").status).toBe("in_progress");
    expect(h.turns).toHaveLength(2);

    probe.answer(false);
    await first;
    await h.flush();

    expect(h.task("delivered").status).toBe("todo");
    expect(h.turns).toHaveLength(2);
    // Still in the memory queue the dashboard lists, not a bare "queued".
    expect(h.task("delivered").dispatchError).toBe("waiting-memory");
  });
});

describe("la ripresa di una card parcheggiata segue la riga della sua board", () => {
  it("sotto il pavimento di memoria: la card leggera riparte alla sua riga, quella con worktree aspetta", async () => {
    const h = await withOneQuietTurn({ held: 8.5 });
    h.park("quiet-parked", QUIET);
    h.park("repo-parked", REPO);

    await h.dispatcher.resume("repo-parked", "continua");
    expect(h.turns).toHaveLength(1);
    expect(h.task("repo-parked").dispatchError).toBe("waiting-memory");

    // A resume that starts awaits its turn, and the turn never ends here.
    void h.dispatcher.resume("quiet-parked", "continua");
    await h.flush();
    expect(h.turns).toHaveLength(2);
  });

  it("sotto il tetto per risorse: la stessa differenza sulla pressione di memoria", async () => {
    const sample: MachineBudgetSample = {
      cores: 12, totalMemGB: 32, ourCoreUnits: 0.5, otherCoreUnits: 1,
      ourMemGB: 1, availableMemGB: 5, running: 1,
    };
    const h = await withOneQuietTurn({ held: 20, budget: sample });
    pastTheRamp();
    h.svc.setGlobalCap({ auto: false, max: 4, mode: "resources", budgetShare: 0.8 });
    h.park("quiet-parked", QUIET);
    h.park("repo-parked", REPO);

    await h.dispatcher.resume("repo-parked", "continua");
    expect(h.turns).toHaveLength(1);

    // A resume that starts awaits its turn, and the turn never ends here.
    void h.dispatcher.resume("quiet-parked", "continua");
    await h.flush();
    expect(h.turns).toHaveLength(2);
  });
});

describe("la coda di memoria e la capacità parlano col prezzo della board", () => {
  it("l'istantanea prezza ogni turno e ogni card in attesa a quello della sua board", async () => {
    const h = await withOneQuietTurn({ held: 7 });
    h.seed("quiet-wait", QUIET);
    h.seed("repo-wait", REPO);

    await h.dispatch(QUIET);
    await h.dispatch(REPO);

    // The snapshot encodes the ids for the wire: the order says who is who.
    const snapshot = h.dispatcher.memoryQueueSnapshot();
    expect(snapshot.running.map((r) => r.weightGB)).toEqual([1]);
    expect(snapshot.queue.map((q) => q.costGB)).toEqual([1, 4]);
  });

  it("la capacità risponde per board: la leggera passa, quella con worktree no, e senza board vale il prezzo caro", async () => {
    const h = await withOneQuietTurn({ held: 8.5 });

    expect(h.dispatcher.admissionPreview?.(QUIET)?.blockedBy ?? null).toBeNull();
    expect(h.dispatcher.admissionPreview?.(REPO)?.blockedBy).toBe("floor");
    expect(h.dispatcher.admissionPreview?.()?.blockedBy).toBe("floor");
    expect(h.dispatcher.admissionPreview?.("board-sconosciuta")?.blockedBy).toBe("floor");
  });

  it("nel tetto per risorse la capacità porta il prezzo e la quota della board", async () => {
    const sample: MachineBudgetSample = {
      cores: 12, totalMemGB: 32, ourCoreUnits: 0.5, otherCoreUnits: 1,
      ourMemGB: 1, availableMemGB: 5, running: 1,
    };
    const h = await withOneQuietTurn({ held: 20, budget: sample });
    h.svc.setGlobalCap({ auto: false, max: 4, mode: "resources", budgetShare: 0.8 });

    expect(h.dispatcher.admissionPreview?.(QUIET)).toMatchObject({ admit: true, costMemGB: 1 });
    expect(h.dispatcher.admissionPreview?.(REPO)).toMatchObject({ admit: false, blockedBy: "memory", costMemGB: 4 });
  });
});

describe("il peso misurato delle card sposta la riga della board", () => {
  /** Three cards of `board` that each grew the server tree by half a giga, one at a time. */
  async function weighThree(h: ReturnType<typeof harness>, board: string) {
    h.dispatcher.sampleCardWeight(1.0); // the idle server: the baseline
    for (const id of ["w1", "w2", "w3"]) {
      h.seed(id, board);
      await h.dispatch(board);
      expect(h.task(id).status).toBe("in_progress");
      h.dispatcher.sampleCardWeight(1.5);
      await h.endTurn(id);
    }
  }

  it("una board con worktree misurata a 0,5 GB parte accanto a un turno, dove il listino da 4 la teneva ferma", async () => {
    // List line: 6 + 4 + 4 = 14 GB. Measured line: 6 + 0.5 + 0.5 = 7 GB.
    const h = harness({ held: 8.5 });
    await weighThree(h, REPO);
    h.seed("first", REPO);
    await h.dispatch(REPO);
    h.seed("second", REPO);

    await h.dispatch(REPO);

    expect(h.task("first").status).toBe("in_progress");
    expect(h.task("second").status).toBe("in_progress");
    // The machine verdict still reads the list; the card asked again at its board's weight.
    expect(h.holds.some((hold) => Math.abs(hold.cardGB - 0.5) < 1e-9)).toBe(true);
  });

  it("sotto la riga misurata (6 + 0,5 + 0,5 = 7 GB) la card aspetta lo stesso", async () => {
    const h = harness({ held: 6.9 });
    await weighThree(h, REPO);
    h.seed("first", REPO);
    await h.dispatch(REPO);
    h.seed("second", REPO);

    await h.dispatch(REPO);

    expect(h.task("second").status).toBe("todo");
    expect(h.dispatcher.admissionPreview?.(REPO)?.reason).toContain("7.0 GB");
  });

  it("le misure di una board non abbassano la riga di un'altra", async () => {
    const h = harness({ held: 8.5 });
    await weighThree(h, QUIET);
    h.seed("first", REPO);
    await h.dispatch(REPO);
    h.seed("second", REPO);

    await h.dispatch(REPO);

    expect(h.task("second").status).toBe("todo");
  });
});
