/**
 * THE CAP "BY RESOURCES": one budget, "Topics may use up to N% of this PC".
 *
 * The dispatcher is driven with a FAKE measure: our core-units, the others',
 * memory and the agents in flight are injected, because the case that matters
 * ("over the budget, nothing starts") cannot be measured on the machine running
 * the suite without asserting on whatever else is running next to it.
 *
 * What is measured:
 *  1. Over the budget with agents running: nothing starts, the card gets the
 *     `queued` chip and a line WITH the numbers, the block publishes as
 *     `pressure`, and the line is written once per episode. Under it: it starts.
 *  2. The first agent is exempt: an empty fleet starts even on a busy machine.
 *  3. The memory axis blocks on its own.
 *  4. In this mode the numeric cap does not apply, and the ramp is one start per
 *     poll on a clock the whole dispatcher shares.
 *  5. The hard floor still wins over the budget, in both modes.
 *  6. REGRESSION: in `count` mode the probe is never consulted and the number
 *     rules exactly as before.
 *  7. The row round-trips: a db without the column reads as count mode with the
 *     default budget; a written budget comes back clamped.
 * @covers KANBAN-75
 */
import { describe, it, expect, setSystemTime } from "bun:test";
import { Database } from "bun:sqlite";
import { BUDGET_SHARE_DEFAULT, BUDGET_SHARE_MAX, budgetShare, capMode, type MachineBudgetSample } from "../../shared/board";
import { createTaskService, type TaskService } from "./tasks";
import { createTaskDispatcher, type DispatcherDeps } from "./task-dispatcher";
import { currentDispatchBlock, heldResumeBlock, setDispatchBlock } from "./dispatch-block-signal";
import { readGlobalCap, type ResourceFloorVerdict } from "./dispatch-capacity";

/**
 * A sentence as the floor VERDICT the dispatcher now takes: these tests inject
 * the text, and which floor it came from is read off its first word - the one
 * place still allowed to, because here the text IS the fixture.
 */
function asFloor(reason: string | null): ResourceFloorVerdict {
  return { reason, kind: reason ? (reason.startsWith("Disco") ? "disk" : "memory") : null, memoryFirstCardExempt: false };
}

import type { TurnEndInfo } from "../providers/stop-reason";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL, APP_SETTINGS_DDL } from "../db/test-schema";
import { createTaskAttemptStore } from "./task-attempts";

/** The '*' row as the migration leaves it: the three new columns, all NULL. */
const BOARD_SETTINGS_DDL = `CREATE TABLE board_settings (
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
  -- migration 20260906004423 + 20260907214600: the cap "by resources".
  max_agents_mode TEXT, max_load_ratio REAL, max_mem_ratio REAL,
  machine_budget_share REAL
)`;

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  db.run(`CREATE TABLE topics (id TEXT PRIMARY KEY)`);
  db.run(TASKS_DDL);
  db.run(TASKS_FK_STUBS_DDL);
  db.run(TASK_LABELS_DDL);
  db.run(BOARD_SETTINGS_DDL);
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
    kind TEXT NOT NULL DEFAULT 'comment',
    message_id TEXT
  )`);
  db.run(`CREATE TABLE approvals (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, requested_by TEXT NOT NULL,
    approval_type TEXT NOT NULL, from_status TEXT, to_status TEXT, confidence_score REAL,
    rubric_scores TEXT, justification TEXT, status TEXT NOT NULL DEFAULT 'pending',
    reviewed_by TEXT, review_comment TEXT, created_at TEXT NOT NULL, reviewed_at TEXT, expires_at TEXT
  )`);
  // The auto-dispatch switch lives in `app_settings`, one row per machine.
  db.run(APP_SETTINGS_DDL);
  db.run("UPDATE app_settings SET auto_dispatch = 1 WHERE id = 1");
  return db;
}

const PID = "alpha-abc123";

let seq = 0;
function seedTask(db: Database, id = `t${++seq}`): string {
  const ts = new Date(Date.now() + ++seq).toISOString();
  db.run(
    `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, dispatch_attempts, priority)
     VALUES (?, ?, ?, 'todo', ?, ?, 0, 2)`,
    [id, PID, "task " + id, ts, ts],
  );
  return id;
}

/** A twelve-core, 32 GB machine, quiet, with a few agents in flight: Topics is
 *  holding two core-units of it and somebody else one. */
const QUIET: MachineBudgetSample = {
  cores: 12, totalMemGB: 32, ourCoreUnits: 2, otherCoreUnits: 1,
  ourMemGB: 3, availableMemGB: 20, running: 2,
};

/**
 * The real service and dispatcher, a fake host and a fake machine. The turns
 * never end on their own, so a started agent stays in flight and the count of
 * created topics is the count of agents that started.
 */
function harness(overrides: Partial<DispatcherDeps> = {}) {
  const db = freshDb();
  const svc: TaskService = createTaskService(db);
  const topicsCreated: string[] = [];
  const logLines: string[] = [];
  /** The machine as the dispatcher will read it; tests move it between ticks. */
  const machine = { pressure: { ...QUIET } as MachineBudgetSample | null, reads: 0 };

  const deps: DispatcherDeps = {
    svc,
    attempts: createTaskAttemptStore(db),
    resolveProject: () => ({ path: "/Users/x/Projects/alpha", projectStoreId: "store-1" }),
    createTopic: () => {
      const n = topicsCreated.length + 1;
      topicsCreated.push(`topic-${n}`);
      db.run("INSERT OR IGNORE INTO topics (id) VALUES (?)", [`topic-${n}`]);
      return { topicId: `topic-${n}`, sessionKey: `topic:sk${n}` };
    },
    createWorktree: async (storeId) => `wt-${storeId}`,
    runTurn: () => new Promise<TurnEndInfo | void>(() => { /* stays in flight */ }),
    broadcast: () => {},
    graceMs: 0,
    retryBackoffMs: 0,
    log: (m: string) => logLines.push(m),
    budgetSample: () => { machine.reads++; return machine.pressure; },
    // A price list that says "one core-unit each", so the arithmetic in the
    // assertions is the arithmetic of the budget and not of a moving estimate.
    agentCostSamples: () => [1, 1, 1],
    ...overrides,
  };
  const dispatcher = createTaskDispatcher(deps);
  return {
    db, svc, dispatcher, topicsCreated, logLines, machine,
    task: (id: string) => svc.get(id)?.task,
    notes: (id: string, needle: string) =>
      (svc.get(id)?.comments ?? []).filter((c) => c.content.includes(needle)),
  };
}

const flush = async (n = 12) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

function boardOn(h: ReturnType<typeof harness>): void {
  h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: false });
}

describe("the cap by resources: over the budget nothing starts, under it it does", () => {
  it("holds the queue with the numbers on the card, once per episode, and lets go when the use drops", async () => {
    const h = harness();
    boardOn(h);
    h.svc.setGlobalCap({ auto: false, max: 4, mode: "resources", budgetShare: 0.5 });
    // Budget: 50% of 12 cores = 6 core-units. We are at 5.8, and one more agent
    // costs 1: it does not fit.
    h.machine.pressure = { ...QUIET, ourCoreUnits: 5.8, running: 2 };
    seedTask(h.db, "p1");

    await h.dispatcher.tick(PID);
    await flush();
    await h.dispatcher.tick(PID);
    await flush();

    expect(h.topicsCreated).toHaveLength(0);
    // The chip says where the card is, and the block is readable by the mapper
    // under its OWN kind: the tone for "it will pass" is not the floor's.
    expect(h.task("p1")!.dispatchState).toBe("queued");
    expect(currentDispatchBlock()).toMatchObject({ kind: "pressure" });
    expect(currentDispatchBlock()!.reason).toContain("core a disposizione");

    // The line carries the use, the cores at Topics' disposal, the share, and
    // promises the restart: 50% of the 11 cores the others (1) leave is 5.5.
    const notes = h.notes("p1", "core a disposizione");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.kind).toBe("service");
    expect(notes[0]!.content).toContain("5,8 dei 5,5 core a disposizione");
    expect(notes[0]!.content).toContain("quota 50% del libero");
    expect(notes[0]!.content).toContain("riparte da sé");
    // And the log said it once, not once per tick.
    expect(h.logLines.filter((l) => l.includes("coda in attesa per budget"))).toHaveLength(1);

    // The use drops well under the resume line (80% of 6 = 4.8): the same card
    // starts, the block clears, the log says so.
    h.machine.pressure = { ...QUIET, ourCoreUnits: 1, running: 2 };
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.topicsCreated).toHaveLength(1);
    expect(currentDispatchBlock()).toBeNull();
    expect(h.logLines.filter((l) => l.includes("coda ripartita"))).toHaveLength(1);
    // No second line on the card for the same episode.
    expect(h.notes("p1", "core a disposizione")).toHaveLength(1);
  });

  it("does not resume where it stopped: between the resume line and the budget it keeps holding", async () => {
    const h = harness();
    boardOn(h);
    h.svc.setGlobalCap({ mode: "resources", budgetShare: 0.5 });
    // Over the budget first, so the gate is holding.
    h.machine.pressure = { ...QUIET, ourCoreUnits: 6.5, running: 2 };
    await h.dispatcher.tick(PID);
    await flush();
    seedTask(h.db, "hy1");

    // 4.9 of 6: under the budget (4.9 + 1 would be 5.9), but over the 80%
    // resume line, so nothing starts yet. This is the gap the eight cards of
    // 2026-09-07 went through.
    h.machine.pressure = { ...QUIET, ourCoreUnits: 4.9, running: 2 };
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.topicsCreated).toHaveLength(0);

    // Under the resume line: it goes.
    h.machine.pressure = { ...QUIET, ourCoreUnits: 3, running: 2 };
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.topicsCreated).toHaveLength(1);
  });

  it("what the others take shrinks the budget, and the line says why", async () => {
    const h = harness();
    boardOn(h);
    h.svc.setGlobalCap({ mode: "resources", budgetShare: 0.8 });
    // Budget 9.6 core-units, but somebody else is holding 10 of the 12 cores:
    // 80% of the 2 left is usable, 1.6, and we are already at 1.5.
    h.machine.pressure = { ...QUIET, ourCoreUnits: 1.5, otherCoreUnits: 10, running: 2 };
    seedTask(h.db, "o1");

    await h.dispatcher.tick(PID);
    await flush();

    expect(h.topicsCreated).toHaveLength(0);
    const notes = h.notes("o1", "core a disposizione");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.content).toContain("1,5 dei 1,6 core a disposizione");
    expect(notes[0]!.content).toContain("il resto della macchina sta lavorando");
  });

  it("the preview the panel reads is the gate's answer, and reading it does not move the gate", async () => {
    const h = harness();
    boardOn(h);
    h.svc.setGlobalCap({ mode: "resources", budgetShare: 0.5 });
    // 5.4 of the 5.5 usable, one more costs 1: the gate holds.
    h.machine.pressure = { ...QUIET, ourCoreUnits: 5.4, running: 2 };
    expect(h.dispatcher.admissionPreview?.()).toMatchObject({ admit: false, blockedBy: "cpu", firstAgentExempt: false });
    // Reading it twice does not enter "holding": at 4.4 (under the budget, over
    // the 80% resume line) a real tick still starts a card, which it would not
    // if the preview had moved the state.
    expect(h.dispatcher.admissionPreview?.()).toMatchObject({ admit: false });
    h.machine.pressure = { ...QUIET, ourCoreUnits: 4.4, running: 2 };
    expect(h.dispatcher.admissionPreview?.()).toMatchObject({ admit: true, blockedBy: null });
    seedTask(h.db, "pv1");
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.topicsCreated).toHaveLength(1);
    // Outside the budget mode, with no floor holding, there is no verdict to preview.
    h.svc.setGlobalCap({ mode: "count" });
    expect(h.dispatcher.admissionPreview?.()).toBeNull();
  });

  // THE NIGHT'S SHAPE: 5.5 GB available on a native runtime, under the 6 GB
  // floor and well over the point where the budget's memory axis fires (1.5 GB
  // of cost against 60% of 5.5). The floor was the only brake that held, and the
  // panel said in green that a new agent would start.
  it("the preview says the floor holds, in either mode, before the budget is asked", async () => {
    const floor = { reason: null as string | null };
    const h = harness({ resourceBlock: () => asFloor(floor.reason) });
    boardOn(h);
    h.svc.setGlobalCap({ mode: "resources", budgetShare: 0.6 });
    h.machine.pressure = { ...QUIET, ourCoreUnits: 2, otherCoreUnits: 1, ourMemGB: 9, availableMemGB: 5.5, running: 3 };
    floor.reason = "Memoria quasi finita: 5.5 GB disponibili, sotto il pavimento di 6 GB. Riprendo appena si libera memoria: niente è andato perso.";
    seedTask(h.db, "fl1");
    const lines = (word: string) => h.logLines.filter((l) => l.includes(word));

    // A panel polls BEFORE any tick has read the floor. The log's dedup state is
    // still empty, so a preview that went through the logging read would write
    // the episode here; only the tick may.
    expect(h.dispatcher.admissionPreview?.()).toMatchObject({ admit: false, blockedBy: "floor", firstAgentExempt: false });
    expect(h.dispatcher.admissionPreview?.()?.reason).toContain("5.5 GB disponibili");
    // In count mode there is no budget verdict, but the floor holds there too.
    h.svc.setGlobalCap({ mode: "count" });
    expect(h.dispatcher.admissionPreview?.()).toMatchObject({ admit: false, blockedBy: "floor" });
    expect(lines("coda ferma")).toHaveLength(0);

    h.svc.setGlobalCap({ mode: "resources" });
    await h.dispatcher.tick(PID);
    await flush();
    // The gate holds for real, and the tick says so once: the log does capture it.
    expect(h.topicsCreated).toHaveLength(0);
    expect(lines("coda ferma")).toHaveLength(1);
    expect(h.dispatcher.admissionPreview?.()).toMatchObject({ admit: false, blockedBy: "floor" });

    // The floor lifts: count mode has nothing to say, the budget admits again,
    // and a poll does not announce the restart the tick has not seen yet.
    // Lifted means memory came back: at 5.5 GB one more card priced at 4 GB
    // would still not fit in 60% of the free, and the budget would say memory.
    floor.reason = null;
    h.machine.pressure = { ...h.machine.pressure, availableMemGB: 12 };
    h.svc.setGlobalCap({ mode: "count" });
    expect(h.dispatcher.admissionPreview?.()).toBeNull();
    h.svc.setGlobalCap({ mode: "resources" });
    expect(h.dispatcher.admissionPreview?.()).toMatchObject({ admit: true, blockedBy: null });
    expect(lines("coda ripartita")).toHaveLength(0);
    expect(lines("coda ferma")).toHaveLength(1);
  });

  it("the preview says a planned restart holds the queue, in count mode too", () => {
    const h = harness();
    h.svc.setGlobalCap({ auto: false, max: 4 });
    expect(h.dispatcher.admissionPreview?.()).toBeNull();
    h.dispatcher.drain("test");
    expect(h.dispatcher.admissionPreview?.()).toMatchObject({ admit: false, blockedBy: "drain" });
  });

  // The panel printed the bare probe ("2.0 of 6.6") while the gate decided on
  // the probe plus the turns admitted in the last ninety seconds ("6.5 of 6.6"
  // on the card). The preview carries the gate's own numbers.
  it("the preview carries the numbers the gate decided on, reservation included", async () => {
    const h = harness();
    boardOn(h);
    h.svc.setGlobalCap({ mode: "resources", budgetShare: 0.5 });
    h.machine.pressure = { ...QUIET, ourCoreUnits: 1, running: 2 };
    seedTask(h.db, "rs1");
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.topicsCreated).toHaveLength(1);

    // One turn launched a moment ago, priced at 1 core-unit and at the 4 GB
    // floor of a card's memory: the probe still says 1, the gate counts 2, and
    // 4 GB of the 20 free are held for it, so 50% of 16 is left.
    expect(h.dispatcher.admissionPreview?.()).toMatchObject({
      admit: true,
      usedCoreUnits: 2,
      usableCoreUnits: 5.5,
      pendingAdmissions: 1,
      costMemGB: 4,
      freeQuotaMemGB: 8,
      ourMemGB: 3,
      memClause: null,
    });
  });

  // A resume held by the floor sat in the In-progress column with a bare queued
  // chip. Its reason is the block of ITS hold, written by the hold itself: the
  // block the tick publishes is refreshed only on boards the tick reaches.
  const FLOOR_TEXT = "Memoria quasi finita: 4.1 GB disponibili, sotto il pavimento di 6 GB. Riprendo appena si libera memoria: niente è andato perso.";
  function inProgressCard(h: ReturnType<typeof harness>, id: string): void {
    const ts = new Date().toISOString();
    h.db.run("INSERT OR IGNORE INTO topics (id) VALUES (?)", [`topic-${id}`]);
    h.db.run(
      `INSERT INTO tasks (id, project_id, text, status, assigned_topic_id, created_at, updated_at, dispatch_attempts, priority)
       VALUES (?, ?, 'held resume', 'in_progress', ?, ?, ?, 1, 2)`,
      [id, PID, `topic-${id}`, ts, ts],
    );
  }

  it("a held resume says the block of its own hold, and stops the moment its hold says otherwise", async () => {
    const floor = { reason: FLOOR_TEXT as string | null };
    const gates = { n: 0 };
    const h = harness({ resourceBlock: () => asFloor(floor.reason), checksRunning: () => gates.n });
    boardOn(h);
    inProgressCard(h, "rh1");
    try {
      // Still holding: the reason is on the row and on the card, no tick needed.
      await h.dispatcher.resume("rh1", "continua");
      expect(h.topicsCreated).toHaveLength(0);
      expect(h.task("rh1")!.dispatchError).toContain("4.1 GB disponibili");
      expect(h.task("rh1")!.queueReason).toMatchObject({ kind: "resource_floor", tone: "stalled" });
      // The floor clears while the cap is full: the re-evaluation holds on the cap
      // alone, and the card has no machine reason left.
      floor.reason = null;
      gates.n = 99;
      await h.dispatcher.resume("rh1", "");
      expect(h.task("rh1")!.dispatchState).toBe("queued");
      expect(h.task("rh1")!.queueReason).toBeNull();
      // The budget holds it: a wait that passes by itself, in its own tone.
      gates.n = 0;
      h.svc.setGlobalCap({ mode: "resources", budgetShare: 0.5 });
      h.machine.pressure = { ...QUIET, ourCoreUnits: 5.8, running: 2 };
      await h.dispatcher.resume("rh1", "");
      expect(h.task("rh1")!.queueReason).toMatchObject({ kind: "resource_pressure", tone: "waiting" });
      h.svc.setGlobalCap({ mode: "count" });
      // The 24h spend holds it: the todo card's sentence, with its kind.
      const spend = h.svc as unknown as { getSpendCaps: () => object; agentSpend: () => object };
      spend.getSpendCaps = () => ({ perTaskCents: 0, perDayCents: 1_000 });
      spend.agentSpend = () => ({ cents24h: 1_200, centsTotal: 1_200, unpricedCostTokens24h: 0, unpricedCostTokensTotal: 0 });
      await h.dispatcher.resume("rh1", "");
      expect(h.task("rh1")!.queueReason).toMatchObject({ kind: "spend_cap" });
      expect(h.task("rh1")!.dispatchError).toStartWith("Tetto di spesa giornaliero raggiunto");
      // Room again: it starts, and the hold's entry goes with the wait.
      const heldText = h.task("rh1")!.dispatchError;
      spend.getSpendCaps = () => ({ perTaskCents: 0, perDayCents: 0 });
      gates.n = 0;
      void h.dispatcher.resume("rh1", "");   // the turn never ends in this harness
      await flush();
      expect(h.task("rh1")!.dispatchState).toBe("working");
      expect(heldResumeBlock("rh1", heldText)).toBeNull();
    } finally {
      h.dispatcher.shutdown();
    }
  });

  // The two gestures of a floor night that leave the published block behind:
  // the queue emptied by hand (the reconcile ticks only boards with queued
  // todos) and the board paused (the tick returns before it publishes).
  for (const [gesture, card] of [["the queue emptied", "stale-backlog"], ["the board paused", "stale-paused"]] as const) {
    it(`a floor published and cleared with ${gesture} is not what a held resume says`, async () => {
      const floor = { reason: FLOOR_TEXT as string | null };
      const gates = { n: 0 };
      const h = harness({ resourceBlock: () => asFloor(floor.reason), checksRunning: () => gates.n });
      boardOn(h);
      const todo = seedTask(h.db);
      try {
        await h.dispatcher.tick(PID);
        await flush();
        expect(currentDispatchBlock()?.kind).toBe("resources");
        if (gesture === "the queue emptied") h.db.run("UPDATE tasks SET status = 'backlog', dispatch_state = NULL WHERE id = ?", [todo]);
        else h.svc.updateBoardSettings(PID, { dispatchPaused: true });
        floor.reason = null;
        await h.dispatcher.reconcile({ reason: "poll" });
        await flush();
        // The premise: the published block is still the floor that has cleared.
        expect(currentDispatchBlock()?.kind).toBe("resources");
        inProgressCard(h, card);
        gates.n = 99;
        await h.dispatcher.resume(card, "rivedi il punto 2");
        expect(h.task(card)!.dispatchState).toBe("queued");
        expect(h.task(card)!.queueReason).toBeNull();
      } finally {
        h.dispatcher.shutdown();
        setDispatchBlock(null);
      }
    });
  }

  it("exempts the first agent: an empty fleet starts even on a busy machine", async () => {
    const h = harness();
    boardOn(h);
    h.svc.setGlobalCap({ mode: "resources" });
    h.machine.pressure = { ...QUIET, ourCoreUnits: 30, running: 0 };
    seedTask(h.db, "e1");

    await h.dispatcher.tick(PID);
    await flush();

    expect(h.topicsCreated).toHaveLength(1);
    expect(currentDispatchBlock()).toBeNull();
    expect(h.logLines.filter((l) => l.includes("il primo parte comunque"))).toHaveLength(1);
  });

  it("blocks on memory alone", async () => {
    const h = harness();
    boardOn(h);
    h.svc.setGlobalCap({ mode: "resources", budgetShare: 0.5 });
    // 20 GB held of a 16 GB budget (50% of 32), while the CPU is fine.
    h.machine.pressure = { ...QUIET, ourCoreUnits: 0.5, ourMemGB: 20, running: 1 };
    seedTask(h.db, "m1");

    await h.dispatcher.tick(PID);
    await flush();

    expect(h.topicsCreated).toHaveLength(0);
    expect(currentDispatchBlock()).toMatchObject({ kind: "pressure" });
    const notes = h.notes("m1", "Non c'è memoria per un altro agent");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.content).toContain("50%");
    // THE FOOTPRINT CLAUSE fired, not the quota: 10 GB of the 20 free is our
    // share and one more agent needs 1.5. The sentence names what Topics holds
    // against its ceiling, never "needs 1,5 GB, 10,0 GB free", which by its own
    // numbers would admit.
    expect(notes[0]!.content).toContain("Topics tiene 20,0 GB");
    expect(notes[0]!.content).toContain("(16,0 GB)");
    expect(notes[0]!.content).not.toContain("ne servono");
    expect(h.dispatcher.admissionPreview?.()).toMatchObject({
      blockedBy: "memory", memClause: "footprint", ourMemGB: 20, usableMemGB: 16,
    });
  });

  // The axis the machine actually hits: the RAM is gone, our footprint is
  // modest, and the old comparison (footprint against the whole-machine budget)
  // could not see it. Half a gigabyte free is the reading of the night at 22:20.
  it("blocks on memory when the machine has none left, whatever our footprint is", async () => {
    const h = harness();
    boardOn(h);
    h.svc.setGlobalCap({ mode: "resources", budgetShare: 0.8 });
    h.machine.pressure = { ...QUIET, ourCoreUnits: 1.1, ourMemGB: 3, availableMemGB: 0.5, running: 2 };
    seedTask(h.db, "m2");

    await h.dispatcher.tick(PID);
    await flush();

    expect(h.topicsCreated).toHaveLength(0);
    const notes = h.notes("m2", "Non c'è memoria per un altro agent");
    expect(notes).toHaveLength(1);
    // The quota clause: the two numbers the axis compared.
    expect(notes[0]!.content).toContain("ne servono 4,0 GB, liberi per Topics 0,4 GB");
    expect(h.dispatcher.admissionPreview?.()).toMatchObject({ blockedBy: "memory", memClause: "quota" });
  });

  it("ramps ONE new dispatch per poll, and ignores the numeric cap: three cards on a cap of 1, three polls, three agents", async () => {
    const h = harness();
    boardOn(h);
    h.svc.setGlobalCap({ auto: false, max: 1, mode: "resources" });
    // A quiet machine with nothing running: every verdict of a single round
    // would read the same quiet measure, so the round admits one card only.
    h.machine.pressure = { ...QUIET, ourCoreUnits: 0.2, running: 0 };
    seedTask(h.db, "n1"); seedTask(h.db, "n2"); seedTask(h.db, "n3");
    const t0 = Date.now();
    try {
      setSystemTime(new Date(t0));
      await h.dispatcher.tick(PID);
      await flush();
      expect(h.topicsCreated).toHaveLength(1);
      // The others are told where they are, and nothing holds the whole queue.
      expect(h.task("n2")!.dispatchState).toBe("queued");
      expect(h.task("n3")!.dispatchState).toBe("queued");
      expect(currentDispatchBlock()).toBeNull();

      // The ramp is a clock, not a counter of calls: a second tick at the same
      // instant (another board, a grace timer) starts nothing.
      await h.dispatcher.tick(PID);
      await flush();
      expect(h.topicsCreated).toHaveLength(1);

      setSystemTime(new Date(t0 + 10_000));
      await h.dispatcher.tick(PID);
      await flush();
      expect(h.topicsCreated).toHaveLength(2);

      // Third poll, third agent: the cap of 1 never applied, the ramp did.
      setSystemTime(new Date(t0 + 20_000));
      await h.dispatcher.tick(PID);
      await flush();
      expect(h.topicsCreated).toHaveLength(3);

      // Nothing left: a fourth poll starts nothing.
      setSystemTime(new Date(t0 + 30_000));
      await h.dispatcher.tick(PID);
      await flush();
      expect(h.topicsCreated).toHaveLength(3);
    } finally {
      setSystemTime();
    }
  });

  it("the hard floor wins over the budget: a full disk is not a wait that passes", async () => {
    const h = harness({ resourceBlock: () => asFloor("Disco quasi pieno: 2 GB liberi.") });
    boardOn(h);
    h.svc.setGlobalCap({ mode: "resources" });
    h.machine.pressure = { ...QUIET, ourCoreUnits: 30, running: 3 };
    seedTask(h.db, "f1");

    await h.dispatcher.tick(PID);
    await flush();

    expect(h.topicsCreated).toHaveLength(0);
    expect(currentDispatchBlock()).toMatchObject({ kind: "resources" });
    expect(h.notes("f1", "Disco quasi pieno")).toHaveLength(1);
    expect(h.notes("f1", "Topics usa il")).toHaveLength(0);
    // The probe was not even asked: with the floor holding there is nothing
    // left for the budget to decide.
    expect(h.machine.reads).toBe(0);
  });
});

describe("count mode is untouched", () => {
  it("never consults the probe and the number rules as before", async () => {
    const h = harness();
    boardOn(h);
    // Default mode (nothing written): a machine screaming over every budget.
    h.svc.setGlobalCap({ auto: false, max: 1 });
    h.machine.pressure = { ...QUIET, ourCoreUnits: 40, ourMemGB: 31, availableMemGB: 1, running: 5 };
    seedTask(h.db, "c1"); seedTask(h.db, "c2");

    await h.dispatcher.tick(PID);
    await flush();

    // One started (the cap of 1), the other waits on the cap, not on the budget.
    expect(h.topicsCreated).toHaveLength(1);
    expect(h.machine.reads).toBe(0);
    expect(currentDispatchBlock()).toBeNull();
    expect(h.notes("c2", "Topics usa il")).toHaveLength(0);
    expect(h.notes("c2", "In coda")).toHaveLength(1);
  });

  it("an explicit `count` behaves like the absent one", async () => {
    const h = harness();
    boardOn(h);
    h.svc.setGlobalCap({ auto: false, max: 2, mode: "count", budgetShare: 0.5 });
    h.machine.pressure = { ...QUIET, ourCoreUnits: 40, running: 5 };
    seedTask(h.db, "k1"); seedTask(h.db, "k2"); seedTask(h.db, "k3");

    await h.dispatcher.tick(PID);
    await flush();

    expect(h.topicsCreated).toHaveLength(2);
    expect(h.machine.reads).toBe(0);
  });
});

describe("the row round-trips", () => {
  it("a db without the column reads as count mode with the default budget", () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE board_settings (project_id TEXT PRIMARY KEY, max_agents INTEGER, max_agents_auto INTEGER)");
    db.run("INSERT INTO board_settings (project_id, max_agents, max_agents_auto) VALUES ('*', 4, 0)");
    const cap = readGlobalCap(db);
    // "As written": nothing written, nothing carried. The two readers of the
    // contract turn the absence into the defaults, so the older `toEqual`
    // tests on this row keep passing unchanged.
    expect(cap).toEqual({ auto: false, max: 4 });
    expect(capMode(cap)).toBe("count");
    expect(budgetShare(cap)).toBe(BUDGET_SHARE_DEFAULT);
  });

  it("writes the mode and clamps the budget on the way in", () => {
    const h = harness();
    const cap = h.svc.setGlobalCap({ mode: "resources", budgetShare: 9 });
    expect(cap.mode).toBe("resources");
    // 9 is out of range: what lands on disk is the ceiling, so the panel and
    // the gate read the same number.
    expect(cap.budgetShare).toBe(BUDGET_SHARE_MAX);
    expect(readGlobalCap(h.db)).toMatchObject({ mode: "resources", budgetShare: BUDGET_SHARE_MAX });
    // Back to count: the row no longer says `resources`, so the field is gone
    // and `capMode` reads the default; the budget stays written for when the
    // mode comes back.
    const back = h.svc.setGlobalCap({ mode: "count" });
    expect(back.mode).toBeUndefined();
    expect(capMode(back)).toBe("count");
    expect(back.budgetShare).toBe(BUDGET_SHARE_MAX);
  });
});
