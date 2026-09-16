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
 *  7. The memory floor reads the lowest reading of a 2-minute window (D1-D7):
 *     single readings never reopen it, the window is empty at boot, a turn in
 *     flight is charged once (the budget axis in resources mode, the floor in
 *     count mode), and the budget axis reads the same window.
 *  8. A card whose checks only wait on the pull request CI reserves no memory.
 *  9. A tick parked on the delivery probe does not start a second card after
 *     another board's tick started one in the gap.
 * @covers KANBAN-75
 */
import { describe, it, expect, setSystemTime, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import type { MachineBudgetSample } from "../../shared/board";
import { createTaskService, type TaskService } from "./tasks";
import { createTaskDispatcher, type DispatcherDeps } from "./task-dispatcher";
import { currentDispatchBlock } from "./dispatch-block-signal";
import { dispatchResourceBlock } from "./dispatch-capacity";
import { createMemSignal } from "./mem-signal";
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

});

/**
 * THE FLOOR READS THE LOWEST READING OF 2 MINUTES, and the life-of-turn
 * reservation is charged once. The real floor composer fed by a real memory
 * signal over a fake probe; the harness's budget sample reads the same window.
 */
describe("the memory window on the floor and on the budget axis", () => {
  function windowHarness(mode: "resources" | "count", overrides: Partial<DispatcherDeps> = {}) {
    let reading = 20;
    const signal = createMemSignal({
      measurable: true,
      probe: async () => ({ availGB: reading, swapins: 0, compressorPages: 0, pageSize: 16_384, swapUsedMB: 0, load1: 1 }),
    });
    const h = harness({
      agentMemSamples: () => [],
      agentCostSamples: () => [0.1],
      resourceBlock: (hold) => dispatchResourceBlock("/tmp", () => 500, () => signal.held(), false, hold),
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

  it("D1, the 10:37 replay: ten minutes at 5.8, one reading at 14.5, then 5.5 start nothing", async () => {
    const w = windowHarness("resources");
    for (let i = 0; i < 3; i++) seedTodo(w.h.db, `d1-${i}`);
    await w.beats([...repeat(5.8, 60), 14.5, ...repeat(5.5, 18)]);
    expect(w.h.startedAt).toHaveLength(0);
    expect(currentDispatchBlock()?.reason ?? "").toContain("Memoria quasi finita");
  });

  it("D2, the 11:03 shape: 5.5, 10.4, 5.5 starts nothing", async () => {
    const w = windowHarness("resources");
    for (let i = 0; i < 3; i++) seedTodo(w.h.db, `d2-${i}`);
    await w.beats([...repeat(5.5, 13), 10.4, ...repeat(5.5, 13)]);
    expect(w.h.startedAt).toHaveLength(0);
  });

  it("D3, boot: an empty window admits nothing for 120 s, then the first card starts", async () => {
    const w = windowHarness("resources");
    for (let i = 0; i < 3; i++) seedTodo(w.h.db, `d3-${i}`);
    await w.beats(repeat(12, 12)); // 0 .. 110 s
    expect(w.h.startedAt).toHaveLength(0);
    expect(currentDispatchBlock()?.reason ?? "").toContain("la sto misurando da 110 s su 120");
    await w.beats(repeat(12, 2)); // 120, 130 s
    expect(w.h.startedAt.length).toBeGreaterThanOrEqual(1);
    expect(Math.min(...w.startsSec())).toBeGreaterThanOrEqual(120);
  });

  it("D4: a turn in flight does not starve the queue at 10 GB, and a window dipping to 9.5 holds it", async () => {
    for (const [low, expected] of [[10.2, 1], [9.5, 0]] as const) {
      const w = windowHarness("resources");
      seedTodo(w.h.db, `d4-first-${low}`);
      await w.beats(repeat(20, 14));
      expect(w.h.startedAt).toHaveLength(1);
      // Ten minutes of a turn waiting on a human: no check tree, the reading is back to normal.
      await w.beats(repeat(20, 60));
      for (let i = 0; i < 3; i++) seedTodo(w.h.db, `d4-${low}-${i}`);
      await w.beat(5.5);
      const bite = w.sec() - 10;
      const band = [low, 11.7, 10.8, 11.2];
      await w.beats(Array.from({ length: 24 }, (_, i) => band[i % band.length]!));
      const later = w.startsSec().slice(1);
      expect(later).toHaveLength(expected);
      if (expected) {
        expect(later[0]!).toBeGreaterThanOrEqual(bite + 120);
        expect(later[0]!).toBeLessThanOrEqual(bite + 130);
      }
    }
  });

  it("D5: one window opening is bounded: exactly two starts, the third held by the budget axis, and no second memory episode", async () => {
    const w = windowHarness("resources");
    for (let i = 0; i < 3; i++) seedTodo(w.h.db, `d5-${i}`);
    await w.beats(repeat(5.5, 13)); // a full window at the bite, 0 .. 120 s
    const bite = w.sec() - 10;
    const band = [10.4, 11.7, 11.0];
    await w.beats(Array.from({ length: 30 }, (_, i) => band[i % band.length]!));
    const starts = w.startsSec();
    expect(starts).toHaveLength(2);
    expect(starts[0]!).toBeGreaterThanOrEqual(bite + 120);
    expect(starts[1]! - starts[0]!).toBeLessThanOrEqual(10);
    expect(currentDispatchBlock()).toMatchObject({ kind: "pressure" });
    const afterFirst = w.h.logLines.slice(w.h.logLines.findIndex((l) => l.includes("coda ripartita")) + 1);
    expect(afterFirst.filter((l) => l.includes("coda ferma") && l.includes("Memoria"))).toHaveLength(0);
  });

  it("D6, count mode: the floor charges the turn in flight for its whole life", async () => {
    const w = windowHarness("count");
    seedTodo(w.h.db, "d6-first");
    await w.beats(repeat(20, 13));
    expect(w.h.startedAt).toHaveLength(1);
    await w.beats(repeat(20, 30)); // five minutes: past any warm-up window
    seedTodo(w.h.db, "d6-second");
    await w.beats(repeat(11, 14));
    expect(w.h.startedAt).toHaveLength(1);
    const reason = currentDispatchBlock()?.reason ?? "";
    expect(reason).toContain("4.0 GB tenuti per l'agente al lavoro");
    expect(reason).toContain("sotto i 14.0 GB");
  });

  it("D7: the budget axis reads the window, so a reading of 14 between two of 10.5 does not start a third card", async () => {
    const w = windowHarness("resources");
    for (let i = 0; i < 2; i++) seedTodo(w.h.db, `d7-${i}`);
    await w.beats(repeat(30, 15));
    expect(w.h.startedAt).toHaveLength(2);
    seedTodo(w.h.db, "d7-third");
    await w.beats(Array.from({ length: 30 }, (_, i) => (i % 2 ? 14 : 10.5)));
    expect(w.h.startedAt).toHaveLength(2);
  });
});

describe("a card waiting on the pull request CI holds no memory here (KANBAN-84)", () => {
  async function thirdCardStarts(offLane: boolean): Promise<{ started: number; reason: string }> {
    const h = harness({
      agentMemSamples: () => [4],
      agentCostSamples: () => [0.1],
      checksOffLane: () => offLane,
    });
    h.svc.setGlobalCap({ mode: "resources", budgetShare: 0.5 });
    // running 2: with 0 the first-agent exemption would admit whatever the memory says.
    h.machine.sample = () => ({ ...QUIET, availableMemGB: 14, running: 2 });
    for (let i = 0; i < 3; i++) seedTodo(h.db, `ci-wait-${i}`);
    const t0 = Date.now();
    setSystemTime(new Date(t0));
    await h.dispatcher.tick(PID);
    await flush();
    setSystemTime(new Date(t0 + 10_000));
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.startedAt).toHaveLength(2);
    // Past the spacing and the warm-up: only the memory reservation is left.
    setSystemTime(new Date(t0 + 60 * 60_000));
    await h.dispatcher.tick(PID);
    await flush();
    return { started: h.startedAt.length, reason: currentDispatchBlock()?.reason ?? "" };
  }

  it("two in-flight cards off-lane reserve nothing, so the third starts; on-lane they hold it on memory", async () => {
    expect((await thirdCardStarts(true)).started).toBe(3);
    const held = await thirdCardStarts(false);
    expect(held.started).toBe(2);
    expect(held.reason).toContain("memoria");
  });
});

describe("the ramp across an awaited probe", () => {
  it("two ticks on two boards, one held on the delivery probe: only ONE card starts", async () => {
    let releaseProbe: ((landed: boolean | null) => void) | null = null;
    const h = harness({
      deliveryLanded: () => new Promise<boolean | null>((r) => { releaseProbe = r; }),
    });
    h.svc.setGlobalCap({ mode: "resources", budgetShare: 0.8 });
    const BETA = "beta-def456";
    h.svc.updateBoardSettings(BETA, { autoDispatch: true, dispatchUseWorktree: false });
    seedTodo(h.db, "alpha-delivered");
    h.db.run("UPDATE tasks SET delivery_commit = ? WHERE id = ?", ["abc1234def5678", "alpha-delivered"]);
    seedTodo(h.db, "beta-plain", BETA);

    // Board alpha passes the first ramp check and parks on the probe of its
    // delivery commit; board beta's tick runs in that gap and starts its card.
    const alpha = h.dispatcher.tick(PID);
    for (let i = 0; i < 50 && !releaseProbe; i++) await flush(1);
    expect(releaseProbe).not.toBeNull();
    await h.dispatcher.tick(BETA);
    await flush();
    expect(h.startedAt).toHaveLength(1);

    // The probe answers "not on main": alpha reaches its claim nine seconds
    // too early, and the look right before the claim is what stops it.
    releaseProbe!(false);
    await alpha;
    await flush();
    expect(h.startedAt).toHaveLength(1);
    expect(h.svc.get("alpha-delivered")?.task.status).toBe("todo");
  });
});
