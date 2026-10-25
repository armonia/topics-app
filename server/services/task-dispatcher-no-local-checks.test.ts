/**
 * Admission tests for boards without local checks: memory reservation, the
 * emergency floor, one active exemption, restart recovery, and board history.
 * @covers KANBAN-75
 */
import { describe, it, expect, setSystemTime, afterEach, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { UNIT_CI_CHECK, type MachineBudgetSample } from "../../shared/board";
import { createTaskService, type TaskService } from "./tasks";
import { createTaskDispatcher, type DispatcherDeps } from "./task-dispatcher";
import { currentDispatchBlock } from "./dispatch-block-signal";
import { dispatchResourceVerdict } from "./dispatch-capacity";
import { createMemSignal } from "./mem-signal";
import type { TurnEndInfo } from "../providers/stop-reason";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL, APP_SETTINGS_DDL } from "../db/test-schema";
import { createTaskAttemptStore } from "./task-attempts";
import { cleanupTestDataDir, setupTestDataDir, testTmpDir } from "../../tests/integration/helpers";

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
    created_at TEXT NOT NULL, ended_at TEXT, selected_at TEXT, no_local_checks_reservation_gb REAL,
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
    commentsFor: (taskId: string) => db.query<{ content: string }, [string]>("SELECT content FROM task_comments WHERE task_id = ?").all(taskId).map((row) => row.content),
    lines: (needle: string) => logLines.filter((l) => l.includes(needle)),
  };
}

const flush = async (n = 12) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

/**
 * THE FLOOR READS THE LOWEST READING OF 2 MINUTES, and the life-of-turn
 * reservation is charged once. The real floor composer fed by a real memory
 * signal over a fake probe; the harness's budget sample reads the same window.
 */
describe("the memory window on the floor and on the budget axis", () => {
  function windowHarness(mode: "resources" | "count", overrides: Partial<DispatcherDeps> = {}, swapUsedMB = 0) {
    let reading = 20;
    const signal = createMemSignal({
      measurable: true,
      probe: async () => ({ availGB: reading, swapins: 0, compressorPages: 0, pageSize: 16_384, swapUsedMB, swapTotalMB: 16_384, load1: 1 }),
    });
    const h = harness({
      agentMemSamples: () => [],
      agentCostSamples: () => [0.1],
      resourceBlock: (hold) => dispatchResourceVerdict("/tmp", () => 500, () => signal.held(), false, hold),
      ...overrides,
    });
    if (mode === "resources") h.svc.setGlobalCap({ mode: "resources", budgetShare: 0.8 });
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
    const sec = () => (t - t0) / 1000;
    const startsSec = () => h.startedAt.map((ms) => (ms - t0) / 1000);
    return { h, beat, beats, sec, startsSec };
  }
  const repeat = (gb: number, n: number) => Array<number>(n).fill(gb);

  /**
   * KANBAN-75: the no-local-checks card exception at the dispatcher's admission gate.
   * Local review checks keep the normal floor; CI-only rows do not count as
   * local checks. The exception reserves memory and remains global to the host.
   */
  it("E1, COUNT MODE: a board with a local review check stays held under the floor", async () => {
    // COUNT MODE ON PURPOSE, and the mode is the whole point of the case. In
    // resources mode the budget axis blocks this same machine by itself - at
    // `availableMemGB` 4.8, share 0.8 and one turn running its free quota is
    // 3.84 GB against a price of 4 - so a card held there proves nothing about
    // the floor. Here the floor is the ONLY memory brake (the count cap is 4,
    // and three todos never reach it), so every number below is the floor's.
    const checks = 1;
    const w = windowHarness("count", { checksRunning: () => checks });
    addLocalReviewCheck(w.h.svc);
    for (let i = 0; i < 3; i++) seedTodo(w.h.db, `e1-${i}`);
    // A full window well under the 6 GB native floor, with a shard of ours running.
    await w.beats(repeat(4.8, 14));
    expect(w.h.startedAt).toHaveLength(0);
    expect(currentDispatchBlock()?.reason ?? "").toContain("Memoria quasi finita");
    // The active check keeps main's first-card exception closed.
    await w.beats(repeat(4.8, 20));
    expect(w.h.startedAt).toHaveLength(0);
  });

  it("KANBAN-75: stable 5 GB starts one no-local-checks native card and holds the rest", async () => {
    let reservationPrices = 0;
    const w = windowHarness("count", {
      noLocalChecksReservationGB: () => { reservationPrices++; return 1; },
    });
    await w.beats(repeat(5, 14));
    seedTodo(w.h.db, "no-checks-first");
    seedTodo(w.h.db, "no-checks-second");
    await w.beat(5);

    const line = "partita in esenzione: 5,0 GB liberi, board senza check locali";
    expect(w.h.startedAt).toHaveLength(1);
    expect(w.h.commentsFor("no-checks-first")).toContain(line);
    expect(w.h.db.query<{ no_local_checks_reservation_gb: number }, [string]>(
      "SELECT no_local_checks_reservation_gb FROM task_attempts WHERE task_id = ? ORDER BY idx DESC LIMIT 1",
    ).get("no-checks-first")?.no_local_checks_reservation_gb).toBe(1);

    w.h.svc.updateBoardSettings(SECOND_PID, { autoDispatch: true, dispatchUseWorktree: false });
    addLocalReviewCheck(w.h.svc, SECOND_PID);
    seedTodo(w.h.db, "checked-board", SECOND_PID);
    await w.h.dispatcher.tick(SECOND_PID);
    await flush();

    expect(w.h.startedAt).toHaveLength(1);
    expect(reservationPrices).toBe(1);
    expect(w.h.svc.get("no-checks-second")?.task).toMatchObject({ status: "todo", queueReason: { kind: "resource_floor" } });
    expect(w.h.svc.get("checked-board")?.task).toMatchObject({ status: "todo", queueReason: { kind: "resource_floor" } });
    expect(w.h.commentsFor("checked-board").filter((comment) => comment.includes("partita in esenzione"))).toHaveLength(0);
  });

  it("the activation guard closes the race while two boards await delivery", async () => {
    const probes: ((landed: boolean | null) => void)[] = [];
    const w = windowHarness("count", {
      deliveryLanded: () => new Promise<boolean | null>((resolve) => probes.push(resolve)),
    });
    await w.beats(repeat(5, 14));
    w.h.svc.updateBoardSettings(SECOND_PID, { autoDispatch: true, dispatchUseWorktree: false });
    seedTodo(w.h.db, "race-alpha");
    seedTodo(w.h.db, "race-beta", SECOND_PID);
    w.h.db.run("UPDATE tasks SET delivery_commit = ? WHERE id IN (?, ?)", [
      "abc1234def5678", "race-alpha", "race-beta",
    ]);

    const alpha = w.h.dispatcher.tick(PID);
    const beta = w.h.dispatcher.tick(SECOND_PID);
    for (let i = 0; i < 50 && probes.length < 2; i++) await flush(1);
    expect(probes).toHaveLength(2);
    for (const release of probes) release(false);
    await Promise.all([alpha, beta]);
    await flush();

    const comments = w.h.db.query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM task_comments WHERE content LIKE 'partita in esenzione:%'",
    ).get()!.n;
    expect(w.h.startedAt).toHaveLength(1);
    expect(comments).toBe(1);
  });

  it("a board with local checks stays on the normal floor at 4 GB", async () => {
    const w = windowHarness("count", { checksRunning: () => 1 }, 16_384);
    addLocalReviewCheck(w.h.svc);
    seedTodo(w.h.db, "checked-at-four");
    await w.beats(repeat(4, 14));

    expect(w.h.startedAt).toHaveLength(0);
    expect(currentDispatchBlock()?.reason ?? "").toContain("Memoria quasi finita");
    expect(w.h.lines("partita in esenzione")).toHaveLength(0);
  });

  it("resources mode charges a live exemption once, so a checked card starts at 10.5 GB", async () => {
    const w = windowHarness("resources", { noLocalChecksReservationGB: () => 1 });
    w.h.machine.sample = () => ({ ...QUIET, availableMemGB: 30, running: w.h.startedAt.length });
    await w.beats(repeat(5, 14));
    seedTodo(w.h.db, "resource-exempt");
    await w.beat(5);
    expect(w.h.startedAt).toHaveLength(1);

    await w.beats(repeat(10.5, 14));
    w.h.svc.updateBoardSettings(SECOND_PID, { autoDispatch: true, dispatchUseWorktree: false });
    addLocalReviewCheck(w.h.svc, SECOND_PID);
    seedTodo(w.h.db, "resource-checked", SECOND_PID);
    await w.h.dispatcher.tick(SECOND_PID);
    await flush();

    expect(w.h.startedAt).toHaveLength(2);
    expect(w.h.commentsFor("resource-checked").filter((comment) => comment.includes("partita in esenzione"))).toHaveLength(0);
  });

  it("the 2 GB emergency floor holds a no-local-checks first card at 1.9 GB", async () => {
    const w = windowHarness("count", {}, 16_384);
    await w.beats(repeat(1.9, 14));
    seedTodo(w.h.db, "emergency-no-checks");
    await w.beat(1.9);

    expect(w.h.startedAt).toHaveLength(0);
    expect(w.h.lines("partita in esenzione")).toHaveLength(0);
    expect(currentDispatchBlock()?.reason ?? "").toContain("Memoria quasi finita");
  });

  it("E3, COUNT MODE: CI-only review rows do not count as local checks", async () => {
    // CI evidence rows do not disqualify the board, but the first live exception
    // keeps its global reservation until that card leaves the in-flight lane.
    const offLane = new Set<string>();
    const w = windowHarness("count", { checksOffLane: (id) => offLane.has(id) });
    w.h.svc.updateBoardSettings(PID, { reviewChecks: [UNIT_CI_CHECK] });
    await w.beats(repeat(4.8, 14));
    for (let i = 0; i < 3; i++) seedTodo(w.h.db, `e3-${i}`);
    await w.beat(4.8);
    expect(w.h.startedAt).toHaveLength(1);
    // The first card hands its branch over: from here on its checks are GitHub's.
    for (let i = 0; i < 3; i++) offLane.add(`e3-${i}`);
    await w.beats(repeat(4.8, 30));
    expect(w.h.startedAt).toHaveLength(1);
  });

  it("E6, COUNT MODE: a no-local-checks reservation remains charged while its card waits on CI", async () => {
    // THE BAND 6-10 GB, which is where this Mac lives while it frees up, and
    // the state the delivery cycle parks in for about fifteen minutes.
    //
    // Counting the off-lane card in the census (E3) is right, and reserving
    // nothing for it is right too - but the LINE took its branch from the first
    // and its figure from the second: `floor + cardGB + 0` = 10 GB asked of a
    // machine where nothing of ours was spending. Measured before the fix with
    // two off-lane cards and a third asking: `held2m` at 7.0, 8.0 and 9.9 all
    // held, while the same states on origin/main all started.
    const offLane = new Set<string>();
    const w = windowHarness("count", { checksOffLane: (id) => offLane.has(id) });
    await w.beats(repeat(4.8, 14));
    for (let i = 0; i < 3; i++) seedTodo(w.h.db, `e6-${i}`);
    await w.beat(4.8);
    expect(w.h.startedAt).toHaveLength(1);
    // Its local checks passed: from here GitHub measures, and the session is
    // alive and resident but runs no commands. Only the card that actually
    // started goes off-lane - the next one to start is a turn spending here.
    const started = w.h.db.query<{ id: string }, []>("SELECT id FROM tasks WHERE status = 'in_progress'").all();
    expect(started).toHaveLength(1);
    offLane.add(started[0]!.id);
    // The machine frees up to 7 GB, but its 1 GB no-local-checks reservation remains.
    // Fourteen beats flush the 4.8 reading out of the window.
    await w.beats(repeat(7, 14));
    expect(w.h.startedAt).toHaveLength(1);
    // The next card cannot reuse the only no-local-checks exemption while it is held.
    await w.beats(repeat(7, 20));
    expect(w.h.startedAt).toHaveLength(1);
    expect(currentDispatchBlock()?.reason ?? "").toContain("sotto i 11.0 GB");
  });

  it("E4: the exemption is logged once without claiming the floor recovered", async () => {
    // The line the board's history is read from: the 16/09 audit dated "the
    // queue restarted at 23:38" from it, while `held2m` was 4.8 GB against a
    // floor of 6. And ONCE: the floor is read twice in a tick that starts a card
    // (here, and again as `midPassFloor`), which used to print the restart line
    // twice in forty seconds.
    const w = windowHarness("count");
    await w.beats(repeat(4.8, 14));
    seedTodo(w.h.db, "e4-0");
    await w.beat(4.8);
    expect(w.h.startedAt).toHaveLength(1);
    expect(w.h.lines("partita in esenzione: 4,8 GB liberi, board senza check locali")).toHaveLength(1);
    expect(w.h.lines("le risorse sono rientrate sopra il pavimento")).toHaveLength(0);
  });

  it("writes one board comment for each separate exempt start", async () => {
    let finishFirst: (() => void) | null = null;
    let runCount = 0;
    const w = windowHarness("count", {
      runTurn: () => {
        runCount++;
        if (runCount === 1) return new Promise<void>((resolve) => { finishFirst = () => resolve(); });
        return new Promise<void>(() => {});
      },
    });
    await w.beats(repeat(5, 14));
    seedTodo(w.h.db, "comment-first");
    await w.beat(5);
    expect(w.h.startedAt).toHaveLength(1);
    expect(w.h.commentsFor("comment-first").filter((comment) => comment.includes("partita in esenzione"))).toHaveLength(1);

    w.h.db.run("UPDATE tasks SET status = 'review' WHERE id = ?", ["comment-first"]);
    finishFirst!();
    await flush(30);
    seedTodo(w.h.db, "comment-second");
    await w.h.dispatcher.tick(PID);
    await flush();

    const starts = w.h.db.query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM task_comments WHERE content LIKE 'partita in esenzione:%'",
    ).get()!.n;
    expect(w.h.startedAt).toHaveLength(2);
    expect(w.h.commentsFor("comment-second").filter((comment) => comment.includes("partita in esenzione"))).toHaveLength(1);
    expect(starts).toBe(2);
  });

  it("reattach restores one eligible reservation, clears stale rows, and holds another card", async () => {
    const w = windowHarness("count");
    await w.beats(repeat(5, 14));
    const thirdBoard = "gamma-ghi789";
    w.h.svc.updateBoardSettings(SECOND_PID, { autoDispatch: true, dispatchUseWorktree: false });
    w.h.svc.updateBoardSettings(thirdBoard, { autoDispatch: true, dispatchUseWorktree: false });
    addLocalReviewCheck(w.h.svc, thirdBoard);

    const persisted = (taskId: string, projectId: string, reservationGB: number) => {
      seedCutTurn(w.h.db, taskId, projectId);
      const attempt = w.h.attempts.create({ taskId, idx: 1, noLocalChecksReservationGB: reservationGB });
      w.h.attempts.bind(attempt.id, { topicId: `topic-${taskId}` });
    };
    persisted("restart-alpha", PID, 1);
    persisted("restart-beta", SECOND_PID, 0.42);
    persisted("restart-checked", thirdBoard, 1);

    w.h.dispatcher.shutdown();
    const afterRestartDispatcher = createTaskDispatcher({
      ...w.h.deps,
      hasLiveSession: async () => true,
      reattach: () => new Promise<void>(() => {}),
    });
    dispatchers.push(afterRestartDispatcher);
    await afterRestartDispatcher.reconcile({ reason: "boot" });
    await flush();

    const validReservations = ["restart-alpha", "restart-beta"]
      .filter((taskId) => w.h.attempts.getNoLocalChecksReservation(taskId) != null);
    expect(validReservations).toHaveLength(1);
    expect(w.h.attempts.getNoLocalChecksReservation("restart-checked")).toBeNull();

    seedTodo(w.h.db, "restart-next", PID);
    await afterRestartDispatcher.tick(PID);
    await flush();
    expect(w.h.svc.get("restart-next")?.task.status).toBe("todo");
    expect(w.h.startedAt).toHaveLength(0);
  });

  it("E5: the global panel stays held under the floor without a card-specific exemption", async () => {
    const w = windowHarness("count", { checksRunning: () => 1 });
    await w.beats(repeat(4.8, 14));
    expect(w.h.dispatcher.admissionPreview?.()).toMatchObject({ admit: false, blockedBy: "floor", firstAgentExempt: false });
    const r = windowHarness("resources", { checksRunning: () => 1 });
    r.h.machine.sample = () => ({ ...QUIET, availableMemGB: 30, running: 0 });
    await r.beats(repeat(4.8, 14));
    expect(r.h.dispatcher.admissionPreview?.()).toMatchObject({ admit: false, blockedBy: "floor", firstAgentExempt: false });
  });

});
