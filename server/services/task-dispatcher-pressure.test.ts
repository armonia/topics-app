/**
 * THE CAP "BY RESOURCES", the alternative to counting agents.
 *
 * The dispatcher is driven with a FAKE machine: load, cores, memory and the
 * agents in flight are injected, because the case that matters ("over the
 * threshold, nothing starts") cannot be measured on the machine running the
 * suite without asserting on whatever else is running next to it.
 *
 * What is measured:
 *  1. Over the threshold with agents running: nothing starts, the card gets the
 *     `queued` chip and a line WITH the numbers, the block publishes as
 *     `pressure`, and the line is written once per episode. Under it: it starts.
 *  2. The first agent is exempt: an empty fleet starts even on a loaded machine.
 *  3. The memory axis blocks on its own, with its own numbers.
 *  4. In this mode the numeric cap does not apply.
 *  5. The hard floor still wins over the pressure, in both modes.
 *  6. REGRESSION: in `count` mode the probe is never consulted and the number
 *     rules exactly as before.
 *  7. The row round-trips: a db without the columns reads as count mode with
 *     the default thresholds; a written threshold comes back clamped.
 * @covers KANBAN-75
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { capMode, capThresholds, LOAD_RATIO_DEFAULT, LOAD_RATIO_MAX, MEM_RATIO_DEFAULT, type MachinePressure } from "../../shared/board";
import { createTaskService, type TaskService } from "./tasks";
import { createTaskDispatcher, type DispatcherDeps } from "./task-dispatcher";
import { currentDispatchBlock } from "./dispatch-block-signal";
import { readGlobalCap } from "./dispatch-capacity";
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
  -- migration 20260906004423: the cap "by resources".
  max_agents_mode TEXT, max_load_ratio REAL, max_mem_ratio REAL
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

/** A twelve-core, 32 GB machine, quiet, with a few agents in flight. */
const QUIET: MachinePressure = { load1: 2, cores: 12, availableMemGB: 20, totalMemGB: 32, running: 2 };

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
  const machine = { pressure: { ...QUIET } as MachinePressure | null, reads: 0 };

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
    machinePressure: () => { machine.reads++; return machine.pressure; },
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

describe("the cap by resources: over the threshold nothing starts, under it it does", () => {
  it("holds the queue with the numbers on the card, once per episode, and lets go when the load drops", async () => {
    const h = harness();
    boardOn(h);
    h.svc.setGlobalCap({ auto: false, max: 4, mode: "resources", maxLoadRatio: 0.9 });
    // 14 on 12 cores is 117% of the machine: over a 90% threshold.
    h.machine.pressure = { ...QUIET, load1: 14, running: 2 };
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
    expect(currentDispatchBlock()!.reason).toContain("Carico oltre la soglia");

    // The line carries the reading, the cores, the percentage and the chosen
    // threshold, in that order, and promises the restart.
    const notes = h.notes("p1", "Carico oltre la soglia");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.kind).toBe("service");
    expect(notes[0]!.content).toContain("14,0 su 12 core");
    expect(notes[0]!.content).toContain("117% della macchina");
    expect(notes[0]!.content).toContain("soglia 90%");
    expect(notes[0]!.content).toContain("2 agent al lavoro");
    expect(notes[0]!.content).toContain("riparte da sé");
    // And the log said it once, not once per tick.
    expect(h.logLines.filter((l) => l.includes("coda in attesa per pressione"))).toHaveLength(1);

    // The load drops: the same card starts, the block clears, the log says so.
    h.machine.pressure = { ...QUIET, load1: 3, running: 2 };
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.topicsCreated).toHaveLength(1);
    expect(currentDispatchBlock()).toBeNull();
    expect(h.logLines.filter((l) => l.includes("coda ripartita"))).toHaveLength(1);
    // No second line on the card for the same episode.
    expect(h.notes("p1", "Carico oltre la soglia")).toHaveLength(1);
  });

  it("exempts the first agent: an empty fleet starts even on a loaded machine", async () => {
    const h = harness();
    boardOn(h);
    h.svc.setGlobalCap({ mode: "resources" });
    h.machine.pressure = { ...QUIET, load1: 40, running: 0 };
    seedTask(h.db, "e1");

    await h.dispatcher.tick(PID);
    await flush();

    expect(h.topicsCreated).toHaveLength(1);
    expect(currentDispatchBlock()).toBeNull();
    expect(h.logLines.filter((l) => l.includes("il primo parte comunque"))).toHaveLength(1);
  });

  it("blocks on memory alone, with the memory numbers", async () => {
    const h = harness();
    boardOn(h);
    h.svc.setGlobalCap({ mode: "resources", maxMemRatio: 0.85 });
    // 2 GB available on 32 is 94% used: over 85%, while the load is fine.
    h.machine.pressure = { ...QUIET, load1: 1, availableMemGB: 2, running: 1 };
    seedTask(h.db, "m1");

    await h.dispatcher.tick(PID);
    await flush();

    expect(h.topicsCreated).toHaveLength(0);
    expect(currentDispatchBlock()).toMatchObject({ kind: "pressure" });
    const notes = h.notes("m1", "Memoria oltre la soglia");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.content).toContain("30,0 GB usati su 32,0");
    expect(notes[0]!.content).toContain("94%");
    expect(notes[0]!.content).toContain("soglia 85%");
    expect(notes[0]!.content).toContain("1 agent al lavoro");
  });

  it("ramps ONE new dispatch per tick, and ignores the numeric cap: three cards on a cap of 1, three ticks, three agents", async () => {
    const h = harness();
    boardOn(h);
    h.svc.setGlobalCap({ auto: false, max: 1, mode: "resources" });
    // A quiet machine with nothing running: every verdict of a single round
    // would read the same quiet load, so the round admits one card only.
    h.machine.pressure = { ...QUIET, running: 0 };
    seedTask(h.db, "n1"); seedTask(h.db, "n2"); seedTask(h.db, "n3");

    await h.dispatcher.tick(PID);
    await flush();
    expect(h.topicsCreated).toHaveLength(1);
    // The others are told where they are, and nothing holds the whole queue.
    expect(h.task("n2")!.dispatchState).toBe("queued");
    expect(h.task("n3")!.dispatchState).toBe("queued");
    expect(currentDispatchBlock()).toBeNull();

    await h.dispatcher.tick(PID);
    await flush();
    expect(h.topicsCreated).toHaveLength(2);

    // Third tick, third agent: the cap of 1 never applied, the ramp did.
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.topicsCreated).toHaveLength(3);

    // Nothing left: a fourth tick starts nothing.
    await h.dispatcher.tick(PID);
    await flush();
    expect(h.topicsCreated).toHaveLength(3);
  });

  it("the hard floor wins over the pressure: a full disk is not a wait that passes", async () => {
    const h = harness({ resourceBlock: () => "Disco quasi pieno: 2 GB liberi." });
    boardOn(h);
    h.svc.setGlobalCap({ mode: "resources" });
    h.machine.pressure = { ...QUIET, load1: 40, running: 3 };
    seedTask(h.db, "f1");

    await h.dispatcher.tick(PID);
    await flush();

    expect(h.topicsCreated).toHaveLength(0);
    expect(currentDispatchBlock()).toMatchObject({ kind: "resources" });
    expect(h.notes("f1", "Disco quasi pieno")).toHaveLength(1);
    expect(h.notes("f1", "Carico oltre la soglia")).toHaveLength(0);
    // The probe was not even asked: with the floor holding there is nothing
    // left for the pressure to decide.
    expect(h.machine.reads).toBe(0);
  });
});

describe("count mode is untouched", () => {
  it("never consults the probe and the number rules as before", async () => {
    const h = harness();
    boardOn(h);
    // Default mode (nothing written): a machine screaming over every threshold.
    h.svc.setGlobalCap({ auto: false, max: 1 });
    h.machine.pressure = { load1: 40, cores: 12, availableMemGB: 1, totalMemGB: 32, running: 5 };
    seedTask(h.db, "c1"); seedTask(h.db, "c2");

    await h.dispatcher.tick(PID);
    await flush();

    // One started (the cap of 1), the other waits on the cap, not on pressure.
    expect(h.topicsCreated).toHaveLength(1);
    expect(h.machine.reads).toBe(0);
    expect(currentDispatchBlock()).toBeNull();
    expect(h.notes("c2", "Carico oltre la soglia")).toHaveLength(0);
    expect(h.notes("c2", "In coda")).toHaveLength(1);
  });

  it("an explicit `count` behaves like the absent one", async () => {
    const h = harness();
    boardOn(h);
    h.svc.setGlobalCap({ auto: false, max: 2, mode: "count", maxLoadRatio: 0.5 });
    h.machine.pressure = { ...QUIET, load1: 40, running: 5 };
    seedTask(h.db, "k1"); seedTask(h.db, "k2"); seedTask(h.db, "k3");

    await h.dispatcher.tick(PID);
    await flush();

    expect(h.topicsCreated).toHaveLength(2);
    expect(h.machine.reads).toBe(0);
  });
});

describe("the row round-trips", () => {
  it("a db without the columns reads as count mode with the default thresholds", () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE board_settings (project_id TEXT PRIMARY KEY, max_agents INTEGER, max_agents_auto INTEGER)");
    db.run("INSERT INTO board_settings (project_id, max_agents, max_agents_auto) VALUES ('*', 4, 0)");
    const cap = readGlobalCap(db);
    // "As written": nothing written, nothing carried. The two readers of the
    // contract turn the absence into the defaults, so the older `toEqual`
    // tests on this row keep passing unchanged.
    expect(cap).toEqual({ auto: false, max: 4 });
    expect(capMode(cap)).toBe("count");
    expect(capThresholds(cap)).toEqual({ maxLoadRatio: LOAD_RATIO_DEFAULT, maxMemRatio: MEM_RATIO_DEFAULT });
  });

  it("writes the mode and clamps the thresholds on the way in", () => {
    const h = harness();
    const cap = h.svc.setGlobalCap({ mode: "resources", maxLoadRatio: 9, maxMemRatio: 0.7 });
    expect(cap.mode).toBe("resources");
    // 9 is out of range: what lands on disk is the ceiling, so the panel and
    // the gate read the same number.
    expect(cap.maxLoadRatio).toBe(LOAD_RATIO_MAX);
    expect(cap.maxMemRatio).toBe(0.7);
    expect(readGlobalCap(h.db)).toMatchObject({ mode: "resources", maxLoadRatio: LOAD_RATIO_MAX, maxMemRatio: 0.7 });
    // Back to count: the row no longer says `resources`, so the field is gone
    // and `capMode` reads the default; the thresholds stay written for when
    // the mode comes back.
    const back = h.svc.setGlobalCap({ mode: "count" });
    expect(back.mode).toBeUndefined();
    expect(capMode(back)).toBe("count");
    expect(back.maxLoadRatio).toBe(LOAD_RATIO_MAX);
  });
});
