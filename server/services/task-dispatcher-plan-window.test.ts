/**
 * THE FIVE-HOUR WINDOW, which is the constraint a subscription actually has.
 *
 * The dollar cap next door counts money; on a CLI plan nobody is billed per
 * turn, and what runs out is the window. The dispatcher used to learn about it
 * only at the wall, from a 429, after every card in flight had already died
 * into it. Here it learns from the CLI's own reading and stops STARTING cards
 * while the window is nearly gone.
 *
 * The three cases that matter, and the third is the one that would break every
 * other dispatcher test: no reading recorded means no brake.
 *
 * @covers USAGE-21
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { clearPlanUsage, recordPlanUsage } from "../lib/provider-hold";
import { PLAN_DISPATCH_HOLD_AT } from "../../shared/provider-hold";

import { Database } from "bun:sqlite";
import { createTaskService, type TaskService } from "./tasks";
import { createTaskDispatcher, type DispatcherDeps } from "./task-dispatcher";
import type { TurnEndInfo } from "../providers/stop-reason";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL } from "../db/test-schema";

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  db.run(`CREATE TABLE topics (id TEXT PRIMARY KEY)`);
  db.run(TASKS_DDL);
  db.run(TASKS_FK_STUBS_DDL);
  db.run(TASK_LABELS_DDL);
  // The two cap columns are here with their default: the default is what this
  // file has to be able to measure, not a value written by the harness.
  db.run(`CREATE TABLE board_settings (
    project_id TEXT PRIMARY KEY, require_approval_for_done INTEGER DEFAULT 0,
    require_review_before_done INTEGER DEFAULT 0, block_status_with_pending INTEGER DEFAULT 0,
    only_lead_can_change_status INTEGER DEFAULT 0, max_agents INTEGER DEFAULT 5, auto_expire_hours INTEGER DEFAULT 24,
    auto_dispatch INTEGER NOT NULL DEFAULT 0, dispatch_effort TEXT NOT NULL DEFAULT 'medium',
    dispatch_use_worktree INTEGER NOT NULL DEFAULT 1, dispatch_timeout_min INTEGER NOT NULL DEFAULT 20,
    dispatch_mcp TEXT,
    dispatch_retry_cap INTEGER, dispatch_retry_backoff_s INTEGER,
    max_agents_auto INTEGER, dispatch_fanout INTEGER,
    agent_cost_cap_cents INTEGER NOT NULL DEFAULT 0,
    agent_cost_cap_cents_24h INTEGER NOT NULL DEFAULT 0
  )`);
  db.run(`CREATE TABLE task_comments (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author TEXT NOT NULL DEFAULT 'user',
    content TEXT NOT NULL, mentions TEXT, media TEXT, created_at TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'comment',
    -- migration 20260904190855: the assistant row an agent said this in.
    message_id TEXT
  )`);
  db.run(`CREATE TABLE approvals (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, requested_by TEXT NOT NULL,
    approval_type TEXT NOT NULL, from_status TEXT, to_status TEXT, confidence_score REAL,
    rubric_scores TEXT, justification TEXT, status TEXT NOT NULL DEFAULT 'pending',
    reviewed_by TEXT, review_comment TEXT, created_at TEXT NOT NULL, reviewed_at TEXT, expires_at TEXT
  )`);
  return db;
}

const PID = "alpha-abc123";
let seq = 0;

function seedTask(db: Database, id: string, opts: { model?: string; costCents?: number } = {}): string {
  const ts = new Date(Date.now() + ++seq).toISOString();
  db.run(
    `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, dispatch_attempts, priority, model, agent_cost_cents)
     VALUES (?, ?, ?, 'todo', ?, ?, 0, 2, ?, ?)`,
    [id, PID, "task " + id, ts, ts, opts.model ?? null, opts.costCents ?? 0],
  );
  return id;
}

function harness(overrides: Partial<DispatcherDeps> = {}) {
  const db = freshDb();
  const svc: TaskService = createTaskService(db);
  const turns: { sessionKey: string; content: string }[] = [];

  const deps: DispatcherDeps = {
    svc,
    resolveProject: () => ({ path: "/tmp/alpha", projectStoreId: "store-1" }),
    createTopic: () => {
      const n = turns.length + 1;
      db.run("INSERT OR IGNORE INTO topics (id) VALUES (?)", [`t-${n}`]);
      return { topicId: `t-${n}`, sessionKey: `topic:sk${n}` };
    },
    archiveTopic: () => {},
    getLastAgentText: () => ({ text: "riassunto", id: "m-riassunto" }),
    runTurn: (sessionKey, content) => {
      turns.push({ sessionKey, content });
      return Promise.resolve<TurnEndInfo | void>(undefined);
    },
    broadcast: () => {},
    graceMs: 0,
    retryBackoffMs: 0,
    log: () => {},
    ...overrides,
  };
  const dispatcher = createTaskDispatcher(deps);
  return {
    db, svc, dispatcher, turns,
    task: (id: string) => svc.get(id)?.task,
    comments: (id: string) => (svc.get(id)?.comments ?? []).map((c) => c.content),
  };
}

const flush = async (n = 12) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

function board(h: ReturnType<typeof harness>): void {
  h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: false });
  h.svc.setGlobalCap({ auto: false, max: 4 });
}


const HOUR = 3_600_000;

describe("il freno della finestra del piano", () => {
  beforeEach(() => { clearPlanUsage(); });
  afterEach(() => { clearPlanUsage(); });

  it("sopra la soglia non parte niente, e lo dice una volta sola", async () => {
    const logs: string[] = [];
    const h = harness({ log: (m: string) => logs.push(m) });
    board(h);
    seedTask(h.db, "w1");
    recordPlanUsage({ fiveHour: { utilization: 95, resetsAtMs: Date.now() + HOUR }, sevenDay: null });

    for (let i = 0; i < 3; i++) { await h.dispatcher.tick(PID); await flush(); }

    expect(h.turns.length).toBe(0);
    expect(h.task("w1")!.status).toBe("todo");
    // One line per reset instant, with the number that makes it checkable.
    const said = logs.filter((m) => m.includes("five-hour window"));
    expect(said.length).toBe(1);
    expect(said[0]).toContain("95%");
    expect(said[0]).toMatch(/resumes at \d{2}:\d{2}/);
  });

  it("sotto la soglia parte come sempre", async () => {
    const h = harness();
    board(h);
    seedTask(h.db, "w2");
    recordPlanUsage({ fiveHour: { utilization: 40, resetsAtMs: Date.now() + HOUR }, sevenDay: null });

    await h.dispatcher.tick(PID);
    await flush();

    expect(h.turns.length).toBeGreaterThanOrEqual(1);
  });

  it("senza nessuna lettura parte: «non lo so» non è «sei al limite»", async () => {
    const h = harness();
    board(h);
    seedTask(h.db, "w3");

    await h.dispatcher.tick(PID);
    await flush();

    expect(h.turns.length).toBeGreaterThanOrEqual(1);
  });

  it("una finestra già oltre il suo reset non frena niente", async () => {
    const h = harness();
    board(h);
    seedTask(h.db, "w4");
    // Recorded when it was true, read after the window turned over: the memo
    // drops it by itself, so the queue must not still be braking on it.
    recordPlanUsage({ fiveHour: { utilization: 99, resetsAtMs: Date.now() - 1 }, sevenDay: null });

    await h.dispatcher.tick(PID);
    await flush();

    expect(h.turns.length).toBeGreaterThanOrEqual(1);
  });

  it("la settimana quasi piena non ferma la coda di oggi", async () => {
    const h = harness();
    board(h);
    seedTask(h.db, "w5");
    // The measured case: seven_day at 92% while the five-hour window is fresh.
    // Braking on it would hold the queue for days for a wall nobody hits today.
    recordPlanUsage({ fiveHour: { utilization: 10, resetsAtMs: Date.now() + HOUR }, sevenDay: { utilization: 92, resetsAtMs: Date.now() + 48 * HOUR } });

    await h.dispatcher.tick(PID);
    await flush();

    expect(h.turns.length).toBeGreaterThanOrEqual(1);
  });

  it("la soglia sta sotto il muro: si frena PRIMA di finire la finestra", () => {
    expect(PLAN_DISPATCH_HOLD_AT).toBeLessThan(100);
  });
});
