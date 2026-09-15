/**
 * THE DOORS AROUND THE GATE, closed one by one after the night of 14/09/2026.
 *
 * The real service and dispatcher with a fake machine, like
 * `task-dispatcher-pressure.test.ts`, but these cases are about WHO gets to ask
 * the gate and HOW OFTEN, not about the arithmetic of one verdict:
 *  1. The night, replayed: 24 GB free, 20 cards, one poll every ten seconds,
 *     agents quiet for 160 s and then at 2 cores and 2 GB. At most five start
 *     in five minutes (it was 20 in four).
 *  2. The ramp is the dispatcher's: three boards in one round start one card.
 *  3. A boot full of cut turns resumes one at a time, and the log line counts
 *     what started, not the calls.
 *  4. Overlapping reconcile passes are one pass.
 *  5. A card resumed by hand while the pass awaited the broker is not resumed
 *     (and counted) a second time.
 *  6. The first-agent exemption does not apply while our checks are running.
 *  7. The memory floor holds until there is room for one more agent above it,
 *     and a count-mode tick re-reads it after each start.
 * @covers KANBAN-75
 */
import { describe, it, expect, setSystemTime, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import type { MachineBudgetSample } from "../../shared/board";
import { createTaskService, type TaskService } from "./tasks";
import { createTaskDispatcher, type DispatcherDeps } from "./task-dispatcher";
import { currentDispatchBlock } from "./dispatch-block-signal";
import { dispatchResourceBlock } from "./dispatch-capacity";
import type { TurnEndInfo } from "../providers/stop-reason";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL, APP_SETTINGS_DDL } from "../db/test-schema";
import { createTaskAttemptStore } from "./task-attempts";

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
    created_at TEXT NOT NULL, ended_at TEXT, selected_at TEXT, UNIQUE (task_id, idx)
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

/** A card as the boot finds it: `in_progress` on a live topic, cut mid-turn. */
function seedCutTurn(db: Database, id: string): void {
  const ts = new Date(Date.now() + ++seq).toISOString();
  db.run("INSERT OR IGNORE INTO topics (id) VALUES (?)", [`topic-${id}`]);
  db.run(
    `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, dispatch_attempts, priority,
       dispatch_state, assigned_topic_id)
     VALUES (?, ?, ?, 'in_progress', ?, ?, 1, 2, 'working', ?)`,
    [id, PID, "task " + id, ts, ts, `topic-${id}`],
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
  const logLines: string[] = [];
  const machine: { sample: () => MachineBudgetSample | null } = { sample: () => ({ ...QUIET }) };
  const deps: DispatcherDeps = {
    svc,
    attempts: createTaskAttemptStore(db),
    resolveProject: () => ({ path: "/Users/x/Projects/alpha", projectStoreId: "store-1" }),
    createTopic: () => {
      const n = startedAt.length + 1;
      startedAt.push(Date.now());
      db.run("INSERT OR IGNORE INTO topics (id) VALUES (?)", [`topic-${n}`]);
      return { topicId: `topic-${n}`, sessionKey: `topic:sk${n}` };
    },
    createWorktree: async (storeId) => `wt-${storeId}`,
    topicExists: () => true,
    runTurn: (sessionKey) => new Promise<TurnEndInfo | void>(() => { turns.push(sessionKey); }),
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
    db, svc, dispatcher, startedAt, turns, logLines, machine,
    lines: (needle: string) => logLines.filter((l) => l.includes(needle)),
  };
}

const flush = async (n = 12) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

describe("the ramp and the reservation hold the stampede", () => {
  it("REPLAY 14/09: 24 GB free, 20 cards, a poll every 10 s, agents quiet for 160 s: at most five start in five minutes", async () => {
    const h = harness({ agentCostSamples: () => [], agentMemSamples: () => [] });
    h.svc.setGlobalCap({ mode: "resources", budgetShare: 0.8 });
    for (let i = 0; i < 20; i++) seedTodo(h.db, `night-${i}`);
    // The measured profile: an agent reads its card for about 160 s at a tenth
    // of a core and a few megabytes, then its gates run at 2 cores and 2 GB.
    h.machine.sample = () => {
      let cpu = 0, mem = 0;
      for (const at of h.startedAt) {
        const gates = Date.now() - at >= 160_000;
        cpu += gates ? 2 : 0.1;
        mem += gates ? 2 : 0.05;
      }
      return {
        cores: 12, totalMemGB: 34, ourCoreUnits: 1 + cpu, otherCoreUnits: 3,
        ourMemGB: 2 + mem, availableMemGB: 24 - mem, running: h.startedAt.length,
      };
    };
    const t0 = Date.now();
    for (let poll = 0; poll < 30; poll++) {
      setSystemTime(new Date(t0 + poll * 10_000));
      await h.dispatcher.tick(PID);
      await flush();
    }
    // Priced at four gigabytes each, for their whole turn, 24 GB at 80% has
    // room for five. The queue is not frozen either: it did start.
    expect(h.startedAt.length).toBeGreaterThanOrEqual(4);
    expect(h.startedAt.length).toBeLessThanOrEqual(5);
  });

  it("the ramp is the dispatcher's: three boards with todos start ONE card in a round", async () => {
    const h = harness();
    h.svc.setGlobalCap({ mode: "resources", budgetShare: 0.8 });
    for (const board of ["alpha-abc123", "beta-def456", "gamma-ghi789"]) {
      h.svc.updateBoardSettings(board, { autoDispatch: true, dispatchUseWorktree: false });
      seedTodo(h.db, `card-${board}`, board);
    }
    const t0 = Date.now();
    setSystemTime(new Date(t0));
    await h.dispatcher.reconcile({ reason: "poll" });
    await flush();
    expect(h.startedAt).toHaveLength(1);
    // The next poll starts the next one: a ramp, not a wall.
    setSystemTime(new Date(t0 + 10_000));
    await h.dispatcher.reconcile({ reason: "poll" });
    await flush();
    expect(h.startedAt).toHaveLength(2);
  });

  it("a boot with six cut turns resumes ONE at a time, and the log counts what started", async () => {
    const h = harness();
    h.svc.setGlobalCap({ mode: "resources", budgetShare: 0.8 });
    for (let i = 0; i < 6; i++) seedCutTurn(h.db, `cut-${i}`);
    await h.dispatcher.reconcile({ reason: "boot" });
    await flush();
    expect(h.turns).toHaveLength(1);
    // Five are parked on the ramp, not «riprese»: the line says which is which.
    expect(h.lines("riavvio: 1 riprese (0 in diretta, 1 da capo), 5 in attesa di un posto")).toHaveLength(1);
  });

  it("overlapping reconcile passes are one pass: six broker probes and one log line for six cut turns", async () => {
    let probes = 0;
    const h = harness({
      // The broker answers slowly, like the boot whose event loop stalled 25 s.
      hasLiveSession: async () => { probes++; await new Promise((r) => setTimeout(r, 5)); return false; },
      reattach: async () => {},
    });
    h.svc.setGlobalCap({ auto: false, max: 10 });
    for (let i = 0; i < 6; i++) seedCutTurn(h.db, `lap-${i}`);
    await Promise.all([
      h.dispatcher.reconcile({ reason: "boot" }),
      h.dispatcher.reconcile({ reason: "poll" }),
      h.dispatcher.reconcile({ reason: "poll" }),
    ]);
    await flush();
    expect(h.turns).toHaveLength(6);
    // Three passes asked the broker about the same six cards, one question per
    // card per pass, while the loop was already stalled.
    expect(probes).toBe(6);
    expect(h.lines("riavvio:")).toHaveLength(1);
    expect(h.lines("riavvio: 6 riprese")).toHaveLength(1);
  });

  it("a card resumed by hand while the pass awaited the broker is not resumed, noted or counted again", async () => {
    let release: ((live: boolean) => void) | null = null;
    const h = harness({
      hasLiveSession: () => new Promise<boolean>((r) => { release = r; }),
      reattach: async () => {},
    });
    h.svc.setGlobalCap({ auto: false, max: 10 });
    seedCutTurn(h.db, "by-hand");
    const pass = h.dispatcher.reconcile({ reason: "boot" });
    for (let i = 0; i < 50 && !release; i++) await flush();
    expect(release).not.toBeNull();
    // A person answers on the card in the meantime: its turn starts now.
    await Promise.race([h.dispatcher.resume("by-hand", "vai avanti"), flush()]);
    expect(h.turns).toHaveLength(1);
    release!(false);
    await pass;
    await flush();
    expect(h.turns).toHaveLength(1);
    expect(h.lines("riavvio:")).toHaveLength(0);
    const notes = (h.svc.get("by-hand")?.comments ?? []).map((c) => c.content);
    expect(notes.filter((c) => c.includes("Server ripartito"))).toHaveLength(0);
  });
});

describe("the exemption and the floor", () => {
  it("the first agent is not exempt while our own checks are running", async () => {
    let checks = 1;
    const h = harness({ checksRunning: () => checks, agentCostSamples: () => [1] });
    h.svc.setGlobalCap({ mode: "resources", budgetShare: 0.5 });
    // Far over the budget, no agent in flight, one pre-review run (a shard).
    h.machine.sample = () => ({ ...QUIET, ourCoreUnits: 30, running: 0 });
    seedTodo(h.db, "exempt-1");
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.startedAt).toHaveLength(0);
    expect(currentDispatchBlock()).toMatchObject({ kind: "pressure" });
    // The shard ends: now nothing of ours is on the machine, and the first starts.
    checks = 0;
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.startedAt).toHaveLength(1);
  });

  it("the 6 GB floor reopens only with room for one more agent above it, and a count-mode tick re-reads it after each start", async () => {
    let avail = 5.9;
    const h = harness({
      agentMemSamples: () => [],
      resourceBlock: (reserved) => dispatchResourceBlock("/tmp", () => 500, () => avail, false, reserved),
    });
    h.svc.setGlobalCap({ auto: false, max: 4 });
    for (let i = 0; i < 3; i++) seedTodo(h.db, `floor-${i}`);

    await h.dispatcher.tick(PID);
    await flush();
    expect(h.startedAt).toHaveLength(0);

    // Back over the floor by a hair: a bare threshold opened here, 30 times in
    // eleven minutes. Holding, it needs the floor plus one agent's 4 GB.
    avail = 6.5;
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.startedAt).toHaveLength(0);
    expect(currentDispatchBlock()?.reason).toContain("tenuti per gli agenti che partono");

    // 10.5 GB: room for one above the floor, so it opens. Each start reserves
    // its 4 GB for the warm-up window, and the re-read after the second start
    // finds 10.5 - 8 = 2.5 GB: the third card waits for the next reading.
    avail = 10.5;
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.startedAt).toHaveLength(2);
  });
});
