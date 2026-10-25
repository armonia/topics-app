/**
 * Admission tests for boards without local checks: memory reservation, the
 * emergency floor, one active exemption, restart recovery, and board history.
 * @covers KANBAN-75
 */
import { describe, it, expect, setSystemTime, afterEach, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { budgetShare, capMode, E2E_CI_CHECK, UNIT_CI_CHECK, admissionVerdict, type MachineBudgetSample } from "../../shared/board";
import { createTaskService, type TaskService } from "./tasks";
import { createTaskDispatcher, type DispatcherDeps } from "./task-dispatcher";
import { currentDispatchBlock } from "./dispatch-block-signal";
import { createMemSignal } from "./mem-signal";
import { createDispatchResourceBlock } from "./dispatch-resource-block";
import type { TurnEndInfo } from "../providers/stop-reason";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL, APP_SETTINGS_DDL } from "../db/test-schema";
import { createTaskAttemptStore } from "./task-attempts";
import { cleanupTestDataDir, setupTestDataDir, testTmpDir } from "../../tests/integration/helpers";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { boardHasNoLocalChecks, canStartNoCheckExemption } from "./dispatch-no-check-exemption";

const STATE_ROOT = testTmpDir("task-dispatcher-no-local-checks");
beforeAll(() => setupTestDataDir(`${STATE_ROOT}/data`));
afterAll(() => cleanupTestDataDir(STATE_ROOT));

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

const PID = "alpha-abc123";
let seq = 0;

function seedTodo(db: Database, id: string, projectId = PID): void {
  const ts = new Date(Date.now() + ++seq).toISOString();
  db.run(
    `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, dispatch_attempts, priority)
     VALUES (?, ?, ?, 'todo', ?, ?, 0, 2)`,
    [id, projectId, "task " + id, ts, ts],
  );
}

const SECOND_PID = "beta-def456";
const THIRD_PID = "gamma-ghi789";

function addLocalReviewCheck(svc: TaskService, projectId = PID): void {
  svc.updateBoardSettings(projectId, { reviewChecks: [{ name: "unit", cmd: "bun test" }] });
}

/** A card as the boot finds it: `in_progress` on a live topic, cut mid-turn. */
function seedCutTurn(db: Database, id: string, projectId = PID): void {
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
const QUIET: MachineBudgetSample = {
  cores: 12, totalMemGB: 34, ourCoreUnits: 0.5, otherCoreUnits: 1,
  ourMemGB: 2, availableMemGB: 30, running: 0,
};

const dispatchers: { shutdown(): void }[] = [];
afterEach(() => {
  setSystemTime();
  for (const d of dispatchers.splice(0)) d.shutdown();
});

/** Turns never end, so a started turn stays in flight: `turns` counts starts. */
function harness(overrides: Partial<DispatcherDeps> = {}) {
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

const flush = async (n = 12) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

function sharedWindowHarness(mode: "resources" | "count", overrides: Partial<DispatcherDeps> = {}, swapUsedMB = 0, share = budgetShare({})) {
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

const repeatMemoryReading = (gb: number, n: number) => Array<number>(n).fill(gb);

/**
 * THE FLOOR READS THE LOWEST READING OF 2 MINUTES, and the life-of-turn
 * reservation is charged once. The real floor composer fed by a real memory
 * signal over a fake probe; the harness's budget sample reads the same window.
 */
describe("the memory window on the floor and on the budget axis", () => {
  function windowHarness(mode: "resources" | "count", overrides: Partial<DispatcherDeps> = {}, swapUsedMB = 0, share = budgetShare({})) {
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
    const t0 = Date.now();
    let t = t0;
    /** One 10 s beat: the sampler, then the dispatcher's tick. `startedAtSec` of each start, relative to t0. */
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
  const repeat = (gb: number, n: number) => Array<number>(n).fill(gb);
  const mainMemoryReason = (heldGB: number, lineGB: number, reservedGB = 0) => {
    const gb = (n: number) => n.toFixed(1);
    const kept = reservedGB > 0
      ? ` (il pavimento, il prezzo di una card e ${gb(reservedGB)} GB tenuti per l'agente al lavoro)`
      : "";
    return `Memoria in risalita: la lettura più bassa degli ultimi 2 minuti è ${gb(heldGB)} GB, sopra il pavimento di 6 GB ma sotto i ${gb(lineGB)} GB che servono per una card in più${kept}. ` +
      `Con il runtime nativo la sessione pesa 2,3 MB, ma una card nei suoi check si prezza 4.0 GB, e sotto questa riga la macchina va in swap. ` +
      `Parto quando la memoria resta sopra ${gb(lineGB)} GB per 2 minuti di fila: una lettura sola sopra la riga non basta. Niente è andato perso.`;
  };

  // Baseline outcomes were measured on origin/main@1e6ac8b708 in a detached scratch worktree.
  const MAIN = {
    B1: { starts: 1, exemptionLog: 1 },
    B1AtFive: { starts: 1, firstCardLog: 1, noCheckRows: 0 },
    B1Warmup: { starts: 1 },
    B2: { whileChecks: 0, afterChecks: 1, exemptionLog: 1, falseRecoveryLines: 0 },
    B3: { firstStarts: 1, totalStarts: 1, reasonLineGB: 10 },
    B4: { firstStarts: 1, totalStarts: 2, reason: "" },
    B5: { firstStarts: 1, totalStarts: 1, reasonLineGB: 14, reservedGB: 4 },
    B6: { checkedStarts: 1, totalStarts: 1, exemptionLogs: 0 },
    B7: { starts: 2, exemptionLogs: 0, startSeconds: [140, 150] },
  } as const;

  it("B1 idle Mac, board WITH local checks, held2m 1.9 GB", async () => {
    const w = windowHarness("count", {}, 16_384);
    addLocalReviewCheck(w.h.svc);
    await w.beats(repeat(1.9, 14));
    seedTodo(w.h.db, "b1");
    await w.beat(1.9);
    expect(w.h.startedAt.length).toBe(MAIN.B1.starts);
    expect(w.h.lines("per deroga")).toHaveLength(MAIN.B1.exemptionLog);
  });

  it("B1w idle Mac, board WITH local checks, warm-up", async () => {
    const w = windowHarness("count", {}, 16_384);
    addLocalReviewCheck(w.h.svc);
    seedTodo(w.h.db, "b1w");
    await w.beats(repeat(1.5, 3));
    expect(w.h.startedAt.length).toBe(MAIN.B1Warmup.starts);
  });

  it("B1 idle Mac, board WITH local checks, held2m 5 GB", async () => {
    const w = windowHarness("count");
    addLocalReviewCheck(w.h.svc);
    await w.beats(repeat(5, 14));
    seedTodo(w.h.db, "b1-five");
    await w.beat(5);
    expect(w.h.startedAt.length).toBe(MAIN.B1AtFive.starts);
    expect(w.h.commentsFor("b1-five").filter((content) => content.includes("Partenza in esenzione"))).toHaveLength(MAIN.B1AtFive.noCheckRows);
    expect(w.h.lines("per deroga")).toHaveLength(MAIN.B1AtFive.firstCardLog);
  });

  it("B2 hold -> first-card derogation transition log", async () => {
    let checks = 1;
    const w = windowHarness("count", { checksRunning: () => checks });
    addLocalReviewCheck(w.h.svc);
    seedTodo(w.h.db, "b2");
    await w.beats(repeat(4.8, 14));
    expect(w.h.startedAt.length).toBe(MAIN.B2.whileChecks);
    checks = 0;
    await w.beats(repeat(4.8, 2));
    expect(w.h.startedAt.length).toBe(MAIN.B2.afterChecks);
    expect(w.h.lines("per deroga")).toHaveLength(MAIN.B2.exemptionLog);
    expect(w.h.lines("le risorse sono rientrate sopra il pavimento")).toHaveLength(MAIN.B2.falseRecoveryLines);
  });

  for (const gb of [7, 8, 9, 9.5]) {
    it(`B3 resources mode, first card (no-check board) running, checked card at ${gb} GB`, async () => {
      const w = windowHarness("resources");
      await w.beats(repeat(5, 14));
      seedTodo(w.h.db, `b3-first-${gb}`);
      await w.beat(5);
      expect(w.h.startedAt.length).toBe(MAIN.B3.firstStarts);
      await w.beats(repeat(gb, 14));
      w.h.svc.updateBoardSettings(SECOND_PID, { autoDispatch: true, dispatchUseWorktree: false });
      addLocalReviewCheck(w.h.svc, SECOND_PID);
      seedTodo(w.h.db, `b3-checked-${gb}`, SECOND_PID);
      await w.h.dispatcher.tick(SECOND_PID);
      await flush();
      expect(w.h.startedAt.length).toBe(MAIN.B3.totalStarts);
      expect(currentDispatchBlock()?.reason).toBe(mainMemoryReason(gb, MAIN.B3.reasonLineGB));
    });
  }

  for (const gb of [7, 10.5]) {
    it(`B4 count mode, first card (no-check board) parked on CI, checked card at ${gb} GB`, async () => {
      const offLane = new Set<string>();
      const w = windowHarness("count", { checksOffLane: (id) => offLane.has(id) });
      await w.beats(repeat(5, 14));
      seedTodo(w.h.db, `b4-first-${gb}`);
      await w.beat(5);
      expect(w.h.startedAt.length).toBe(MAIN.B4.firstStarts);
      offLane.add(`b4-first-${gb}`);
      await w.beats(repeat(gb, 14));
      w.h.svc.updateBoardSettings(SECOND_PID, { autoDispatch: true, dispatchUseWorktree: false });
      addLocalReviewCheck(w.h.svc, SECOND_PID);
      seedTodo(w.h.db, `b4-checked-${gb}`, SECOND_PID);
      await w.h.dispatcher.tick(SECOND_PID);
      await flush();
      expect(w.h.startedAt.length).toBe(MAIN.B4.totalStarts);
      expect(currentDispatchBlock()?.reason ?? "").toBe(MAIN.B4.reason);
    });
  }

  for (const gb of [12, 13.5]) {
    it(`B5 count mode, first card (no-check board) spending here, checked card at ${gb} GB`, async () => {
      const w = windowHarness("count");
      await w.beats(repeat(5, 14));
      seedTodo(w.h.db, `b5-first-${gb}`);
      await w.beat(5);
      expect(w.h.startedAt.length).toBe(MAIN.B5.firstStarts);
      await w.beats(repeat(gb, 14));
      w.h.svc.updateBoardSettings(SECOND_PID, { autoDispatch: true, dispatchUseWorktree: false });
      addLocalReviewCheck(w.h.svc, SECOND_PID);
      seedTodo(w.h.db, `b5-checked-${gb}`, SECOND_PID);
      await w.h.dispatcher.tick(SECOND_PID);
      await flush();
      expect(w.h.startedAt.length).toBe(MAIN.B5.totalStarts);
      expect(currentDispatchBlock()?.reason).toBe(mainMemoryReason(gb, MAIN.B5.reasonLineGB, MAIN.B5.reservedGB));
    });
  }

  it("B6 checked card in flight, no-check card at 5 GB (does the exemption exempt anything?)", async () => {
    const w = windowHarness("count");
    w.h.svc.updateBoardSettings(SECOND_PID, { autoDispatch: true, dispatchUseWorktree: false });
    addLocalReviewCheck(w.h.svc, SECOND_PID);
    await w.beats(repeat(20, 14));
    seedTodo(w.h.db, "b6-checked", SECOND_PID);
    await w.h.dispatcher.tick(SECOND_PID);
    await flush();
    expect(w.h.startedAt.length).toBe(MAIN.B6.checkedStarts);
    await w.beats(repeat(5, 14));
    seedTodo(w.h.db, "b6-nochecks");
    seedTodo(w.h.db, "b6-nochecks-second");
    await w.beat(5);
    await w.beats(repeat(5, 3));
    expect(w.h.startedAt.length).toBe(MAIN.B6.totalStarts + 1);
    expect(w.h.commentsFor("b6-nochecks").filter((c) => c.includes("Partenza in esenzione"))).toHaveLength(1);
    expect(w.h.commentsFor("b6-nochecks").some((c) => /tentativo .+/.test(c))).toBe(true);
    expect(w.h.commentsFor("b6-nochecks-second").filter((c) => c.includes("Partenza in esenzione"))).toHaveLength(0);
    expect(w.h.commentsFor("b6-nochecks-second").some((c) => c.includes("Memoria quasi finita"))).toBe(true);
    expect(w.h.db.query<{ status: string }, [string]>("SELECT status FROM tasks WHERE id = ?").get("b6-nochecks-second")?.status).toBe("todo");
  });

  for (const share of [budgetShare({}), 0.8]) {
    it(`budget resources mode keeps the exempt candidate queued below its ${share} quota`, async () => {
      expect(capMode({ mode: "resources" })).toBe("resources");
      expect(budgetShare({})).toBe(0.6);
      const w = windowHarness("resources", { agentMemSamples: () => [4] }, 0, share);
      w.h.svc.updateBoardSettings(SECOND_PID, { autoDispatch: true, dispatchUseWorktree: false });
      addLocalReviewCheck(w.h.svc, SECOND_PID);
      await w.beats(repeat(20, 14));
      seedTodo(w.h.db, `budget-checked-${share}`, SECOND_PID);
      await w.h.dispatcher.tick(SECOND_PID);
      await flush();
      expect(w.h.startedAt.length).toBe(1);
      await w.beats(repeat(5, 14));
      seedTodo(w.h.db, `budget-nocheck-${share}`);
      await w.beat(5);
      expect(w.h.startedAt.length).toBe(1);
      expect(w.h.attempts.getNoLocalChecksReservation?.(`budget-nocheck-${share}`)).toBeNull();
      expect(w.h.commentsFor(`budget-nocheck-${share}`).some((c) => /in coda|Memoria/.test(c))).toBe(true);

      if (share === 0.8) {
        const main = admissionVerdict(
          { ...QUIET, ourMemGB: 2, availableMemGB: 5, reservedMemGB: 4, running: 1 },
          0.8,
          { coreUnits: 0.1, memGB: 1 },
        );
        expect(main.freeQuotaMemGB).toBeCloseTo(0.8);
        expect(main.costMemGB).toBe(1);
        expect(main.admit).toBe(false);
        expect(main.blockedBy).toBe("memory");
      }

      await w.beats(repeat(20, 14));
      const preview = w.h.dispatcher.admissionPreview?.();
      expect(preview?.ourMemGB).toBeCloseTo(2);
    });
  }

  it("B4 the exempt reservation stays off the price list when another card is parked on CI", async () => {
    const offLane = new Set<string>();
    const w = windowHarness("count", { checksOffLane: (id) => offLane.has(id) });
    w.h.svc.updateBoardSettings(SECOND_PID, { autoDispatch: true, dispatchUseWorktree: false });
    addLocalReviewCheck(w.h.svc, SECOND_PID);
    await w.beats(repeat(20, 14));
    seedTodo(w.h.db, "b4-offlane-check", SECOND_PID);
    await w.h.dispatcher.tick(SECOND_PID);
    await flush();
    expect(w.h.startedAt.length).toBe(1);
    offLane.add("b4-offlane-check");

    await w.beats(repeat(5, 14));
    seedTodo(w.h.db, "b4-exempt");
    await w.beat(5);
    expect(w.h.startedAt.length).toBe(2);
    expect(w.h.commentsFor("b4-exempt").some((c) => c.includes("Partenza in esenzione"))).toBe(true);

    await w.beats(repeat(10.5, 14));
    w.h.svc.updateBoardSettings(THIRD_PID, { autoDispatch: true, dispatchUseWorktree: false });
    addLocalReviewCheck(w.h.svc, THIRD_PID);
    seedTodo(w.h.db, "b4-checked-after-ci", THIRD_PID);
    await w.h.dispatcher.tick(THIRD_PID);
    await flush();
    expect(w.h.startedAt.length).toBe(3);
  });

  it("CLI exemption keeps the measured 0.42 GB price", async () => {
    const w = windowHarness("resources", {
      checksRunning: () => 1,
      isCliRuntime: () => true,
      agentMemSamples: () => [4],
    }, 0, 0.8);
    await w.beats(repeat(3, 14));
    seedTodo(w.h.db, "cli-nocheck");
    await w.beat(3);
    expect(w.h.startedAt.length).toBe(1);
    expect(w.h.commentsFor("cli-nocheck").some((c) => c.includes("prenotati 0.42 GB"))).toBe(true);
    await w.beats(repeat(20, 14));
    expect(w.h.dispatcher.admissionPreview?.()?.ourMemGB).toBeCloseTo(2.42);
  });

  it("heavyBusy admits a light no-check card at 5 GB but never exempts a heavy candidate", async () => {
    const w = windowHarness("count");
    w.h.svc.updateBoardSettings(SECOND_PID, { autoDispatch: true, dispatchUseWorktree: false });
    await w.beats(repeat(20, 14));
    seedTodo(w.h.db, "heavy-running", SECOND_PID);
    w.h.db.run("UPDATE tasks SET dispatch_weight = 'heavy' WHERE id = ?", ["heavy-running"]);
    await w.h.dispatcher.tick(SECOND_PID);
    await flush();
    expect(w.h.startedAt.length).toBe(1);

    await w.beats(repeat(5, 14));
    seedTodo(w.h.db, "light-exempt");
    await w.beat(5);
    expect(w.h.startedAt.length).toBe(2);
    expect(w.h.commentsFor("light-exempt").some((c) => c.includes("Partenza in esenzione"))).toBe(true);

    w.h.svc.updateBoardSettings(THIRD_PID, { autoDispatch: true, dispatchUseWorktree: false });
    seedTodo(w.h.db, "heavy-candidate", THIRD_PID);
    w.h.db.run("UPDATE tasks SET dispatch_weight = 'heavy' WHERE id = ?", ["heavy-candidate"]);
    await w.h.dispatcher.tick(THIRD_PID);
    await flush();
    expect(w.h.startedAt.length).toBe(2);
    expect(w.h.commentsFor("heavy-candidate").filter((c) => c.includes("Partenza in esenzione"))).toHaveLength(0);
    expect(w.h.db.query<{ status: string }, [string]>("SELECT status FROM tasks WHERE id = ?").get("heavy-candidate")?.status).toBe("todo");
  });

  it("B7 same task requeued twice keeps main's first-card behavior", async () => {
    let finish: (() => void) | null = null;
    const w = windowHarness("count", {
      runTurn: () => new Promise<void>((resolve) => { finish = () => resolve(); }),
    });
    const t0 = Date.now();
    await w.beats(repeat(5, 14));
    seedTodo(w.h.db, "b7");
    await w.beat(5);
    // Turn ends without delivering; put it back to todo as a requeue would.
    w.h.db.run("UPDATE tasks SET status = 'todo', assigned_topic_id = NULL, dispatch_state = NULL WHERE id = ?", ["b7"]);
    finish!();
    await flush(30);
    w.h.db.run("UPDATE tasks SET status = 'todo', assigned_topic_id = NULL, dispatch_state = NULL WHERE id = ?", ["b7"]);
    await w.beat(5);
    await w.beat(5);
    expect(w.h.startedAt.length).toBe(MAIN.B7.starts);
    expect(w.h.startedAt.map((at) => (at - t0) / 1000)).toEqual([...MAIN.B7.startSeconds]);
    expect(w.h.commentsFor("b7").filter((c) => c.includes("Partenza in esenzione"))).toHaveLength(MAIN.B7.exemptionLogs);
  });

  it("a no-check card restarted within 10 seconds writes one row per attempt", async () => {
    const finishes: (() => void)[] = [];
    const w = windowHarness("count", {
      runTurn: () => new Promise<void>((resolve) => { finishes.push(resolve); }),
    });
    const startNotes: Array<Parameters<TaskService["addComment"]>[0]> = [];
    const addComment = w.h.svc.addComment.bind(w.h.svc);
    w.h.svc.addComment = (args) => {
      if (args.content.includes("Partenza in esenzione")) startNotes.push(args);
      return addComment(args);
    };
    w.h.svc.updateBoardSettings(SECOND_PID, { autoDispatch: true, dispatchUseWorktree: false });
    addLocalReviewCheck(w.h.svc, SECOND_PID);
    await w.beats(repeat(20, 14));
    seedTodo(w.h.db, "restart-check", SECOND_PID);
    await w.h.dispatcher.tick(SECOND_PID);
    await flush();
    await w.beats(repeat(5, 14));
    seedTodo(w.h.db, "restart-exempt");
    await w.beat(5);
    expect(w.h.startedAt.length).toBe(2);
    w.h.db.run("UPDATE tasks SET status = 'todo', assigned_topic_id = NULL, dispatch_state = NULL WHERE id = ?", ["restart-exempt"]);
    finishes[1]!();
    await flush(30);
    await w.h.dispatcher.tick(PID);
    await flush();
    const lines = w.h.commentsFor("restart-exempt").filter((content) => content.includes("Partenza in esenzione"));
    const ids = lines.map((content) => content.match(/tentativo ([^:]+):/)?.[1]);
    expect(w.h.startedAt.length).toBe(3);
    expect(lines).toHaveLength(2);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(2);
    expect(startNotes).toHaveLength(2);
    expect(startNotes.every((note) => note.once !== true)).toBe(true);
  });
});
describe("extra", () => {
  it("B2n hold -> no-check exempt start transition log", async () => {
    const reading = 4.8;
    let checks = 1;
    const signal = createMemSignal({ measurable: true, probe: async () => ({ availGB: reading, swapins: 0, compressorPages: 0, pageSize: 16_384, swapUsedMB: 0, swapTotalMB: 16_384, load1: 1 }) });
    const h = harness({ agentMemSamples: () => [], agentCostSamples: () => [0.1], checksRunning: () => checks,
      heldMemory: () => signal.held(),
      isCliRuntime: () => false,
      resourceBlock: createDispatchResourceBlock({
        worktreesPath: () => "/tmp",
        readFreeGB: () => 500,
        heldMemory: () => signal.held(),
        isCliRuntime: () => false,
      }) });
    h.svc.setGlobalCap({ auto: false, max: 4 });
    let t = Date.now();
    const beat = async () => { setSystemTime(new Date(t)); await signal.sample(); await h.dispatcher.tick(PID); await flush(); t += 10_000; };
    seedTodo(h.db, "b2n");
    for (let i = 0; i < 14; i++) await beat();
    checks = 0;
    for (let i = 0; i < 2; i++) await beat();
    expect(h.startedAt.length).toBe(1);
    expect(h.attempts.getNoLocalChecksReservation?.("b2n")).toBe(1);
    expect(h.commentsFor("b2n").some((line) => line.includes("Partenza in esenzione"))).toBe(true);
  });
});

describe("no-local-check exception lifecycle", () => {
  it("uses only the emergency floor for an empty or CI-only board", () => {
    expect(boardHasNoLocalChecks([])).toBe(true);
    expect(boardHasNoLocalChecks([UNIT_CI_CHECK, E2E_CI_CHECK])).toBe(true);
    expect(boardHasNoLocalChecks([{ name: "local", cmd: "bun test" }])).toBe(false);
  });

  it("holds the emergency threshold at 2 GB when 2.9 GB minus the native reservation leaves 1.9 GB", () => {
    expect(canStartNoCheckExemption({
      boardHasNoLocalChecks: true,
      heldGB: 2.9,
      reservationGB: 1,
    })).toBe(false);
  });

  it("keeps a no-check card below the 2 GB remainder even when another card is running", async () => {
    let reading = 20;
    const signal = createMemSignal({
      measurable: true,
      probe: async () => ({ availGB: reading, swapins: 0, compressorPages: 0, pageSize: 16_384, swapUsedMB: 0, swapTotalMB: 16_384, load1: 1 }),
    });
    const w = harness({
      heldMemory: () => signal.held(),
      isCliRuntime: () => false,
      resourceBlock: createDispatchResourceBlock({
        worktreesPath: () => "/tmp",
        readFreeGB: () => 500,
        heldMemory: () => signal.held(),
        isCliRuntime: () => false,
      }),
    });
    w.svc.updateBoardSettings(SECOND_PID, { autoDispatch: true, dispatchUseWorktree: false });
    addLocalReviewCheck(w.svc, SECOND_PID);
    let now = Date.now();
    const beat = async (gb: number) => {
      reading = gb;
      setSystemTime(new Date(now));
      await signal.sample();
      await w.dispatcher.tick(PID);
      await flush();
      now += 10_000;
    };
    for (let i = 0; i < 14; i++) await beat(20);
    seedTodo(w.db, "floor-checked", SECOND_PID);
    await w.dispatcher.tick(SECOND_PID);
    await flush();
    expect(w.startedAt.length).toBe(1);
    for (let i = 0; i < 14; i++) await beat(2.9);
    seedTodo(w.db, "floor-no-checks");
    await beat(2.9);
    expect(w.startedAt.length).toBe(1);
    expect(w.commentsFor("floor-no-checks").filter((content) => content.includes("Partenza in esenzione"))).toHaveLength(0);
    expect(w.commentsFor("floor-no-checks").some((content) => content.includes("Memoria quasi finita"))).toBe(true);
  });

  it("reattaches a live exempt attempt without duplicating its start line, then frees the slot", async () => {
    let finish: (() => void) | null = null;
    const h = harness({
      heldMemory: () => ({ measurable: true, latestGB: 20, heldGB: 20, coveredMs: 120_000 }),
      isCliRuntime: () => false,
      resourceBlock: () => ({ reason: null, kind: null, memoryFirstCardExempt: false }),
      budgetSample: () => ({ ...QUIET, availableMemGB: 20, running: 1 }),
      hasLiveSession: async () => true,
      reattach: () => new Promise<void>((resolve) => { finish = resolve; }),
    });
    h.svc.setGlobalCap({ mode: "resources", budgetShare: budgetShare({}) });
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: false });
    seedCutTurn(h.db, "reattach-exempt");
    const attempt = h.attempts.create({ taskId: "reattach-exempt", idx: 1, model: null });
    h.attempts.bind(attempt.id, { topicId: "topic-reattach-exempt", worktreeId: null, branch: null });
    h.attempts.setNoLocalChecksReservation?.("reattach-exempt", 1);
    const note = `Partenza in esenzione senza check locali, tentativo ${attempt.id}: prenotati 1.00 GB (stima nativa).`;
    const start = Date.now();
    setSystemTime(new Date(start - 11_000));
    h.svc.addComment({ taskId: "reattach-exempt", author: "system", kind: "service", content: note });
    setSystemTime(new Date(start));

    await h.dispatcher.reconcile({ reason: "boot" });
    await flush();
    expect(h.dispatcher.isInFlight("reattach-exempt")).toBe(true);
    expect(h.attempts.getNoLocalChecksReservation?.("reattach-exempt")).toBe(1);
    expect(h.commentsFor("reattach-exempt").filter((content) => content === note)).toHaveLength(1);
    expect(h.dispatcher.admissionPreview?.()?.ourMemGB).toBeCloseTo(3);

    finish!();
    await flush(30);
    expect(h.attempts.getNoLocalChecksReservation?.("reattach-exempt")).toBeNull();
    expect(h.dispatcher.admissionPreview?.()?.ourMemGB).toBeCloseTo(2);
  });

  it("clears a persisted reservation when reattach finds local checks", async () => {
    const h = harness({
      hasLiveSession: async () => true,
      reattach: () => new Promise<void>(() => {}),
    });
    h.svc.setGlobalCap({ mode: "resources", budgetShare: budgetShare({}) });
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: false });
    addLocalReviewCheck(h.svc);
    seedCutTurn(h.db, "reattach-checked");
    const attempt = h.attempts.create({ taskId: "reattach-checked", idx: 1, model: null });
    h.attempts.bind(attempt.id, { topicId: "topic-reattach-checked", worktreeId: null, branch: null });
    h.attempts.setNoLocalChecksReservation?.("reattach-checked", 1);
    await h.dispatcher.reconcile({ reason: "boot" });
    await flush();
    expect(h.dispatcher.isInFlight("reattach-checked")).toBe(true);
    expect(h.attempts.getNoLocalChecksReservation?.("reattach-checked")).toBeNull();
    expect(h.commentsFor("reattach-checked").filter((content) => content.includes("Partenza in esenzione"))).toHaveLength(0);
  });

  it("keeps only the first persisted reservation when two live cards reattach", async () => {
    const h = harness({
      hasLiveSession: async () => true,
      reattach: () => new Promise<void>(() => {}),
    });
    h.svc.setGlobalCap({ mode: "resources", budgetShare: budgetShare({}) });
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: false });
    for (const [id, topicId] of [["reattach-first", "topic-reattach-first"], ["reattach-second", "topic-reattach-second"]]) {
      seedCutTurn(h.db, id);
      const attempt = h.attempts.create({ taskId: id, idx: 1, model: null });
      h.attempts.bind(attempt.id, { topicId, worktreeId: null, branch: null });
      h.attempts.setNoLocalChecksReservation?.(id, 1);
    }
    await h.dispatcher.reconcile({ reason: "boot" });
    await flush();
    const restored = [
      h.attempts.getNoLocalChecksReservation?.("reattach-first"),
      h.attempts.getNoLocalChecksReservation?.("reattach-second"),
    ];
    expect(restored.filter((reservation) => reservation === 1)).toHaveLength(1);
    expect(restored.filter((reservation) => reservation === null)).toHaveLength(1);
  });

  it("uses the server resource composer for memory, runtime, and one reservation", () => {
    let cliRuntime = false;
    const memory = { measurable: true, latestGB: 6.5, heldGB: 6.5, coveredMs: 120_000 };
    const block = createDispatchResourceBlock({
      worktreesPath: () => "/tmp",
      readFreeGB: () => 500,
      heldMemory: () => memory,
      isCliRuntime: () => cliRuntime,
    });
    const hold = { cardGB: 0, reservedGB: 0, reservedCards: 0, spendingHere: false, ourWorkRunning: true };

    expect(block(hold).reason).toBeNull();
    cliRuntime = true;
    expect(block(hold).reason).toContain("6.5 GB");
    cliRuntime = false;
    expect(block(hold, 1).reason).toContain("5.5 GB");
  });

  it("admits the reserved no-check cost at the quota minimum", async () => {
    const w = sharedWindowHarness("resources", { checksRunning: () => 1 }, 0, 0.8);
    await w.beats(repeatMemoryReading(20, 14));
    await w.beats(repeatMemoryReading(4.8, 14));
    w.h.machine.sample = () => ({ ...QUIET, availableMemGB: 1.25, ourMemGB: 2, running: 1 });
    seedTodo(w.h.db, "quota-at-reservation");

    await w.h.dispatcher.tick(PID);
    await flush();

    expect(w.h.startedAt).toHaveLength(1);
    expect(w.h.attempts.getNoLocalChecksReservation?.("quota-at-reservation")).toBe(1);
    expect(w.h.commentsFor("quota-at-reservation").some((line) => line.includes("Partenza in esenzione"))).toBe(true);
  });

  it("holds the no-check start when free quota is below its reservation", async () => {
    const w = sharedWindowHarness("resources", { checksRunning: () => 1 }, 0, 0.8);
    await w.beats(repeatMemoryReading(20, 14));
    await w.beats(repeatMemoryReading(4.8, 14));
    w.h.machine.sample = () => ({ ...QUIET, availableMemGB: 1.24, ourMemGB: 2, running: 1 });
    seedTodo(w.h.db, "quota-below-reservation");

    await w.h.dispatcher.tick(PID);
    await flush();

    expect(w.h.startedAt).toHaveLength(0);
    expect(w.h.attempts.getNoLocalChecksReservation?.("quota-below-reservation")).toBeNull();
    expect(w.h.commentsFor("quota-below-reservation").join(" ")).toMatch(/in coda|Memoria/);
  });

  it("charges an occupied exempt seat once in resources mode", async () => {
    let checks = 1;
    const w = sharedWindowHarness("resources", { checksRunning: () => checks }, 0, 0.8);
    await w.beats(repeatMemoryReading(20, 14));
    await w.beats(repeatMemoryReading(4.8, 14));
    seedTodo(w.h.db, "s3-exempt");
    await w.h.dispatcher.tick(PID);
    await flush();
    expect(w.h.startedAt).toHaveLength(1);
    expect(w.h.attempts.getNoLocalChecksReservation?.("s3-exempt")).toBe(1);

    checks = 0;
    await w.beats(repeatMemoryReading(6.5, 14));
    w.h.svc.updateBoardSettings(SECOND_PID, { autoDispatch: true, dispatchUseWorktree: false });
    addLocalReviewCheck(w.h.svc, SECOND_PID);
    seedTodo(w.h.db, "s3-checked", SECOND_PID);
    await w.h.dispatcher.tick(SECOND_PID);
    await flush();

    expect(w.h.dispatcher.isInFlight("s3-checked")).toBe(true);
    expect(w.h.startedAt).toHaveLength(2);
  });

  it("keeps the real memory reading in a resources-mode queue reason", async () => {
    const checks = 1;
    let samples: number[] = [];
    const w = sharedWindowHarness("resources", {
      checksRunning: () => checks,
      agentMemSamples: () => samples,
    }, 0, 0.8);
    await w.beats(repeatMemoryReading(20, 14));
    await w.beats(repeatMemoryReading(4.8, 14));
    seedTodo(w.h.db, "resources-reason-exempt");
    await w.h.dispatcher.tick(PID);
    await flush();
    expect(w.h.attempts.getNoLocalChecksReservation?.("resources-reason-exempt")).toBe(1);

    samples = [5.5];
    w.h.svc.updateBoardSettings(SECOND_PID, { autoDispatch: true, dispatchUseWorktree: false });
    addLocalReviewCheck(w.h.svc, SECOND_PID);
    await w.beats(repeatMemoryReading(6.5, 14));
    seedTodo(w.h.db, "resources-reading", SECOND_PID);
    await w.h.dispatcher.tick(SECOND_PID);
    await flush();

    const reason = w.h.commentsFor("resources-reading").find((line) => line.includes("Memoria in risalita")) ?? "";
    expect(reason).toContain("la lettura più bassa degli ultimi 2 minuti è 6.5 GB");
    expect(reason).not.toContain("la lettura più bassa degli ultimi 2 minuti è 5.5 GB");
    expect(w.h.dispatcher.isInFlight("resources-reading")).toBe(false);
  });

  it("starts one light card under heavyBusy, queues its peer, then reuses the released seat", async () => {
    const w = sharedWindowHarness("count", { checksRunning: () => 0 });
    w.h.svc.updateBoardSettings(SECOND_PID, { autoDispatch: true, dispatchUseWorktree: false });
    seedTodo(w.h.db, "seat-heavy", SECOND_PID);
    w.h.db.run("UPDATE tasks SET dispatch_weight = 'heavy' WHERE id = 'seat-heavy'");
    await w.h.dispatcher.tick(SECOND_PID);
    await flush();
    expect(w.h.startedAt).toHaveLength(1);

    await w.beats(repeatMemoryReading(5, 14));
    expect(boardHasNoLocalChecks(w.h.svc.getBoardSettings(PID).reviewChecks)).toBe(true);
    seedTodo(w.h.db, "seat-one");
    seedTodo(w.h.db, "seat-two");
    await w.h.dispatcher.tick(PID);
    await flush();

    expect(w.h.startedAt).toHaveLength(2);
    expect(w.h.attempts.getNoLocalChecksReservation?.("seat-one")).toBe(1);
    expect(w.h.attempts.getNoLocalChecksReservation?.("seat-two")).toBeNull();
    expect(w.h.status("seat-two")).toBe("todo");
    expect(w.h.commentsFor("seat-two").join(" ")).toMatch(/in coda|PESANTE|Memoria/);

    w.h.svc.updateBoardSettings(PID, { autoDispatch: false, dispatchUseWorktree: false });
    w.h.db.run("UPDATE tasks SET status = 'done', dispatch_state = NULL WHERE id = 'seat-one'");
    w.h.dispatcher.onBlockerDone("seat-one");
    expect(w.h.attempts.getNoLocalChecksReservation?.("seat-one")).toBeNull();

    w.h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: false });
    await w.h.dispatcher.tick(PID);
    await flush();
    expect(w.h.startedAt).toHaveLength(3);
    expect(w.h.attempts.getNoLocalChecksReservation?.("seat-two")).toBe(1);
    expect(w.h.commentsFor("seat-two").some((line) => line.includes("Partenza in esenzione"))).toBe(true);
  });

  it("charges an occupied exempt seat once in count mode and reports the effective reading", async () => {
    let checks = 1;
    const w = sharedWindowHarness("count", { checksRunning: () => checks });
    await w.beats(repeatMemoryReading(20, 14));
    await w.beats(repeatMemoryReading(4.8, 14));
    seedTodo(w.h.db, "count-exempt");
    await w.h.dispatcher.tick(PID);
    await flush();
    expect(w.h.startedAt).toHaveLength(1);
    expect(w.h.attempts.getNoLocalChecksReservation?.("count-exempt")).toBe(1);

    checks = 0;
    await w.beats(repeatMemoryReading(6.5, 14));
    w.h.svc.updateBoardSettings(SECOND_PID, { autoDispatch: true, dispatchUseWorktree: false });
    addLocalReviewCheck(w.h.svc, SECOND_PID);
    seedTodo(w.h.db, "count-checked", SECOND_PID);
    await w.h.dispatcher.tick(SECOND_PID);
    await flush();

    const reason = w.h.commentsFor("count-checked").find((line) => line.includes("Memoria quasi finita")) ?? "";
    expect(reason).toContain("5.5 GB");
    expect(reason).not.toContain("4.5 GB");
    expect(w.h.startedAt).toHaveLength(1);
  });

  for (const outcome of ["finished", "closed manually", "errored", "died"] as const) {
    it(`releases the one exempt seat after the first card ${outcome}`, async () => {
      let checks = 1;
      let finish: ((end?: TurnEndInfo) => void) | null = null;
      const w = sharedWindowHarness("count", {
        checksRunning: () => checks,
        livenessGraceMs: 0,
        isTurnAlive: outcome === "died" ? () => false : undefined,
        runTurn: () => new Promise<TurnEndInfo | void>((resolve) => { finish = resolve; }),
      });
      w.h.svc.updateBoardSettings(PID, { autoDispatch: false, dispatchRetryCap: 1 });
      await w.beats(repeatMemoryReading(20, 14));
      await w.beats(repeatMemoryReading(4.8, 14));
      w.h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchRetryCap: 1 });
      seedTodo(w.h.db, "seat-first");
      seedTodo(w.h.db, "seat-second");
      await w.h.dispatcher.tick(PID);
      await flush();

      expect(w.h.startedAt).toHaveLength(1);
      expect(w.h.attempts.getNoLocalChecksReservation?.("seat-first")).toBe(1);
      expect(w.h.status("seat-second")).toBe("todo");
      expect(w.h.commentsFor("seat-second").join(" ")).toMatch(/in coda|Memoria/);

      if (outcome === "finished") {
        w.h.db.run("UPDATE tasks SET status = 'review' WHERE id = 'seat-first'");
        w.h.svc.updateBoardSettings(PID, { autoDispatch: false });
        finish!({ end: "end_turn" });
      } else if (outcome === "closed manually") {
        w.h.db.run("UPDATE tasks SET status = 'done' WHERE id = 'seat-first'");
        w.h.svc.updateBoardSettings(PID, { autoDispatch: false });
        w.h.dispatcher.onBlockerDone("seat-first");
        expect(w.h.attempts.getNoLocalChecksReservation?.("seat-first")).toBeNull();
        finish!({ end: "end_turn" });
      } else if (outcome === "errored") {
        w.h.svc.updateBoardSettings(PID, { autoDispatch: false });
        finish!({ end: "error", cause: "process-died" });
      } else {
        w.h.svc.updateBoardSettings(PID, { autoDispatch: false });
        setSystemTime(new Date(Date.now() + 1_000));
        await w.h.dispatcher.reconcile({ reason: "poll" });
        setSystemTime(new Date(Date.now() + 1_000));
        await w.h.dispatcher.reconcile({ reason: "poll" });
      }
      checks = 0;
      await flush(30);
      expect(w.h.dispatcher.isInFlight("seat-first")).toBe(false);
      expect(w.h.attempts.getNoLocalChecksReservation?.("seat-first")).toBeNull();

      w.h.svc.updateBoardSettings(PID, { autoDispatch: true });
      await w.h.dispatcher.tick(PID);
      await flush();
      expect(w.h.startedAt).toHaveLength(2);
      expect(w.h.dispatcher.isInFlight("seat-second")).toBe(true);
    });
  }

  it("reopening the released card as heavy starts without inheriting its exempt note", async () => {
    const memory = { measurable: true, latestGB: 20, heldGB: 20, coveredMs: 120_000 };
    const w = harness({
      heldMemory: () => memory,
      isCliRuntime: () => false,
      resourceBlock: createDispatchResourceBlock({
        worktreesPath: () => "/tmp",
        readFreeGB: () => 500,
        heldMemory: () => memory,
        isCliRuntime: () => false,
      }),
    });
    w.svc.updateBoardSettings(PID, { autoDispatch: false, dispatchUseWorktree: false });
    seedCutTurn(w.db, "reopened-heavy");
    const attempt = w.attempts.create({ taskId: "reopened-heavy", idx: 1, model: null });
    w.attempts.bind(attempt.id, { topicId: "topic-reopened-heavy", worktreeId: null, branch: null });
    w.attempts.setNoLocalChecksReservation?.("reopened-heavy", 1);
    await w.dispatcher.reconcile({ reason: "boot" });
    await flush();
    expect(w.attempts.getNoLocalChecksReservation?.("reopened-heavy")).toBe(1);
    w.db.run("UPDATE tasks SET status = 'done', dispatch_state = NULL WHERE id = 'reopened-heavy'");
    w.dispatcher.onBlockerDone("reopened-heavy");
    expect(w.attempts.getNoLocalChecksReservation?.("reopened-heavy")).toBeNull();
    w.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: false });
    w.db.run("UPDATE tasks SET status = 'todo', assigned_topic_id = NULL WHERE id = 'reopened-heavy'");
    w.db.run("UPDATE tasks SET dispatch_weight = 'heavy' WHERE id = 'reopened-heavy'");

    await w.dispatcher.tick(PID);
    await flush();

    expect(w.dispatcher.isInFlight("reopened-heavy")).toBe(true);
    expect(w.attempts.getNoLocalChecksReservation?.("reopened-heavy")).toBeNull();
    expect(w.commentsFor("reopened-heavy").filter((line) => line.includes("Partenza in esenzione"))).toHaveLength(0);
  });

  it("keeps the persisted seat out of memory until dispatch allows a live reattach", async () => {
    const h = harness({ hasLiveSession: async () => true, reattach: () => new Promise<void>(() => {}) });
    h.svc.updateBoardSettings(PID, { autoDispatch: false, dispatchUseWorktree: false });
    h.svc.setGlobalCap({ mode: "resources", budgetShare: budgetShare({}) });
    seedCutTurn(h.db, "held-off-exempt");
    const attempt = h.attempts.create({ taskId: "held-off-exempt", idx: 1, model: null });
    h.attempts.bind(attempt.id, { topicId: "topic-held-off-exempt", worktreeId: null, branch: null });
    h.attempts.setNoLocalChecksReservation?.("held-off-exempt", 1);
    await h.dispatcher.reconcile({ reason: "boot" });
    await flush();
    expect(h.attempts.getNoLocalChecksReservation?.("held-off-exempt")).toBe(1);
    expect(h.dispatcher.isInFlight("held-off-exempt")).toBe(false);
    expect(h.dispatcher.admissionPreview?.()?.ourMemGB).toBeCloseTo(2);
    expect(h.svc.get("held-off-exempt")?.comments.some((comment) => comment.content.includes("Dispatch spento"))).toBe(true);

    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: false });
    await h.dispatcher.reconcile({ reason: "poll" });
    await flush();
    expect(h.dispatcher.isInFlight("held-off-exempt")).toBe(true);
    expect(h.attempts.getNoLocalChecksReservation?.("held-off-exempt")).toBe(1);
    expect(h.dispatcher.admissionPreview?.()?.ourMemGB).toBeCloseTo(3);
  });
});
