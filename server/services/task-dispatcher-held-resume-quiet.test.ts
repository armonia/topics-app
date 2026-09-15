/**
 * A HELD RESUME IS QUIET: it writes its chip when the hold changes, not at every retry.
 *
 * Measured on 15/09/2026: with the memory floor holding, each queued resume
 * retried every 5-6.75 s and every retry rewrote `dispatch_error` with the
 * reading of that instant, touched `updated_at` and broadcast `task:updated`.
 * Seven held cards made about 70 frames a minute to every client.
 *
 * The real service and dispatcher, a fake floor whose reading moves at every
 * retry. The retries are driven by hand at the cadence the timer keeps, with the
 * system clock moved between them, so two minutes take milliseconds.
 *  1. Seven cards held for two minutes: at most two frames and two row writes
 *     per card, and the card still reads the kind of its hold.
 *  2. A change of kind (floor, then the 24h spend, then the floor again) and a
 *     change of the words (under the floor, then climbing back) are written at
 *     the very next retry.
 * @covers KANBAN-75
 */
import { describe, it, expect, setSystemTime, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createTaskService, type TaskService } from "./tasks";
import { createTaskDispatcher, type DispatcherDeps } from "./task-dispatcher";
import type { TurnEndInfo } from "../providers/stop-reason";
import type { OutboundMessage } from "../../shared/ws-outbound";
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

/** The floor's sentence as the 15/09 cards carried it, with the reading of the moment. */
const under = (gb: number) =>
  `Memoria quasi finita: ${gb.toFixed(1)} GB disponibili, sotto il pavimento di 6 GB. Riprendo appena si libera memoria: niente è andato perso.`;   // allow-italian: the sentence shown on the card
const climbing = (gb: number) =>
  `Memoria in risalita: ${gb.toFixed(1)} GB disponibili, sopra il pavimento di 6 GB ma senza posto per un agente in più.`;   // allow-italian: the sentence shown on the card

/** The same readings the rows showed that morning, cycled so no two retries in a row agree. */
const READINGS = [5.7, 5.9, 6.0, 5.8];

const dispatchers: { shutdown(): void }[] = [];
afterEach(() => {
  setSystemTime();
  for (const d of dispatchers.splice(0)) d.shutdown();
});

function harness() {
  const db = freshDb();
  const svc: TaskService = createTaskService(db);
  const frames: string[] = [];
  const floor = { next: (): string | null => null };
  const deps: DispatcherDeps = {
    svc,
    attempts: createTaskAttemptStore(db),
    resolveProject: () => ({ path: "/Users/x/Projects/alpha", projectStoreId: "store-1" }),
    createTopic: () => ({ topicId: "topic-new", sessionKey: "topic:new" }),
    createWorktree: async (storeId) => `wt-${storeId}`,
    topicExists: () => true,
    runTurn: () => new Promise<TurnEndInfo | void>(() => { /* stays in flight */ }),
    broadcast: (m: OutboundMessage) => {
      const msg = m as { type: string; task?: { id: string } };
      if (msg.type === "task:updated" && msg.task) frames.push(msg.task.id);
    },
    graceMs: 0,
    retryBackoffMs: 0,
    log: () => {},
    resourceBlock: () => floor.next(),
  };
  const dispatcher = createTaskDispatcher(deps);
  dispatchers.push(dispatcher);
  svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: false });
  svc.setGlobalCap({ auto: false, max: 4 });
  return {
    db, svc, dispatcher, frames, floor,
    task: (id: string) => svc.get(id)!.task,
    framesOf: (id: string) => frames.filter((f) => f === id).length,
  };
}

function heldCard(db: Database, id: string): void {
  const ts = new Date().toISOString();
  db.run("INSERT OR IGNORE INTO topics (id) VALUES (?)", [`topic-${id}`]);
  db.run(
    `INSERT INTO tasks (id, project_id, text, status, assigned_topic_id, created_at, updated_at, dispatch_attempts, priority)
     VALUES (?, ?, 'held resume', 'in_progress', ?, ?, ?, 1, 2)`,
    [id, PID, `topic-${id}`, ts, ts],
  );
}

describe("a held resume writes its chip when the hold changes, not at every retry", () => {
  it("seven cards held by a moving memory reading for two minutes: at most two frames and two writes per card", async () => {
    const h = harness();
    let read = 0;
    h.floor.next = () => under(READINGS[read++ % READINGS.length]!);
    const ids = Array.from({ length: 7 }, (_, i) => `held-${i}`);
    for (const id of ids) heldCard(h.db, id);

    const t0 = Date.now();
    const updatedAt = new Map<string, Set<string>>(ids.map((id) => [id, new Set<string>()]));
    // Twenty retries, 6 s apart (the timer's 5 s plus its stagger): 0 .. 114 s.
    for (let retry = 0; retry < 20; retry++) {
      setSystemTime(new Date(t0 + retry * 6_000));
      for (const id of ids) {
        await h.dispatcher.resume(id, retry === 0 ? "continua" : "");
        updatedAt.get(id)!.add(h.task(id).updatedAt);
      }
    }

    for (const id of ids) {
      // Two, not one: the first hold, and the refresh of its numbers a minute later.
      expect(h.framesOf(id)).toBe(2);
      expect(updatedAt.get(id)!.size).toBeLessThanOrEqual(2);
      // Quiet, not blind: still queued, and the card still reads the floor.
      expect(h.task(id).dispatchState).toBe("queued");
      expect(h.task(id).dispatchError).toContain("sotto il pavimento di 6 GB");
      expect(h.task(id).queueReason).toMatchObject({ kind: "resource_floor" });
    }
    // Nothing started while the floor held.
    expect(h.task(ids[0]!).status).toBe("in_progress");
  });

  it("a change of kind or of words is written at the next retry, and the card reads the new kind", async () => {
    const h = harness();
    let gb = 5.7;
    h.floor.next = () => under(gb);
    heldCard(h.db, "switch");
    const t0 = Date.now();
    let at = 0;
    const retry = async () => {
      setSystemTime(new Date(t0 + (at += 6_000)));
      await h.dispatcher.resume("switch", "");
    };

    await h.dispatcher.resume("switch", "continua");
    expect(h.framesOf("switch")).toBe(1);
    gb = 5.9;
    await retry();
    expect(h.framesOf("switch")).toBe(1);

    // The words change inside the same kind: climbing back is another sentence.
    h.floor.next = () => climbing(6.4);
    await retry();
    expect(h.framesOf("switch")).toBe(2);
    expect(h.task("switch").dispatchError).toStartWith("Memoria in risalita: 6.4 GB");
    expect(h.task("switch").queueReason).toMatchObject({ kind: "resource_floor" });

    // The floor clears and the 24h spend holds it: another kind, written at once.
    h.floor.next = () => null;
    const spend = h.svc as unknown as { getSpendCaps: () => object; agentSpend: () => object };
    spend.getSpendCaps = () => ({ perTaskCents: 0, perDayCents: 1_000 });
    spend.agentSpend = () => ({ cents24h: 1_200, centsTotal: 1_200, unpricedCostTokens24h: 0, unpricedCostTokensTotal: 0 });
    await retry();
    expect(h.framesOf("switch")).toBe(3);
    expect(h.task("switch").dispatchError).toStartWith("Tetto di spesa giornaliero raggiunto");
    expect(h.task("switch").queueReason).toMatchObject({ kind: "spend_cap" });

    // And back to the floor: written at once again, with the reading of now.
    spend.getSpendCaps = () => ({ perTaskCents: 0, perDayCents: 0 });
    h.floor.next = () => under(5.2);
    await retry();
    expect(h.framesOf("switch")).toBe(4);
    expect(h.task("switch").dispatchError).toContain("5.2 GB disponibili");
    expect(h.task("switch").queueReason).toMatchObject({ kind: "resource_floor" });
  });
});
