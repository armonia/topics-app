/**
 * @covers USAGE-30
 * PROJECT PAUSE AT THE RESUME DOOR: an automated resume of a card whose project
 * is paused starts NO turn, and starts by itself when the pause closes.
 *
 * The real task service and dispatcher; only the runner is a counter. A card
 * `in_progress` with its topic bound is what a red bounce, a land retreat or the
 * reconcile poll would resume. Pausing is a real `project_quota` row.
 *  1. Held: zero turns, the card stays in progress (no backlog), and the chip
 *     reads `project-paused`.
 *  2. A person's message (`origin: PERSON`) is never held.
 *  3. After "Continua" (`fireProjectResumed`) the card that was waiting starts
 *     with no other input.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { continueProject } from "./project-pause";
import { openPauseWithLimit } from "../../tests/helpers/paused-project";
import { createTaskService, type TaskService } from "./tasks";
import { createTaskDispatcher, type DispatcherDeps } from "./task-dispatcher";
import { fireProjectResumed, PERSON, resetHeldForTests } from "./turn-gate";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL } from "../db/test-schema";

const MIGRATION = await Bun.file(join(import.meta.dir, "../db/migrations/20261119000000-project-quota.sql")).text();
const PID = "paused-resume-abc123";

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
    dispatch_mcp TEXT,
    dispatch_retry_cap INTEGER, dispatch_retry_backoff_s INTEGER,
    max_agents_auto INTEGER, dispatch_fanout INTEGER,
    agent_cost_cap_cents INTEGER NOT NULL DEFAULT 0,
    agent_cost_cap_cents_24h INTEGER NOT NULL DEFAULT 0
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
  db.exec(MIGRATION);
  return db;
}

const dispatchers: { shutdown(): void }[] = [];
afterEach(() => {
  for (const d of dispatchers.splice(0)) d.shutdown();
  resetHeldForTests();
});

function harness() {
  const db = freshDb();
  const svc: TaskService = createTaskService(db);
  const turns: { sessionKey: string; content: string }[] = [];
  const deps: DispatcherDeps = {
    svc,
    resolveProject: () => ({ path: "/tmp/paused-resume", projectStoreId: "store-1" }),
    createTopic: () => ({ topicId: "topic-new", sessionKey: "topic:new" }),
    topicExists: () => true,
    archiveTopic: () => {},
    // A turn that stays in flight: what the test counts is how many START.
    runTurn: (sessionKey, content) => { turns.push({ sessionKey, content }); return new Promise<void>(() => { /* in flight */ }); },
    broadcast: () => {},
    graceMs: 0,
    retryBackoffMs: 0,
    log: () => {},
  };
  const dispatcher = createTaskDispatcher(deps);
  dispatchers.push(dispatcher);
  svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: false });
  svc.setGlobalCap({ auto: false, max: 4 });
  return { db, svc, dispatcher, turns, task: (id: string) => svc.get(id)!.task };
}

/** Lets the event loop turn a few rounds, or until a turn has started. */
async function settled(turns: unknown[]): Promise<void> {
  for (let i = 0; i < 20 && turns.length === 0; i++) await new Promise((r) => setTimeout(r, 0));
}

/**
 * Sends a resume WITHOUT awaiting it: a resume that starts awaits its turn,
 * which stays in flight here, so awaiting would hang instead of failing the
 * assertion when the gate is gone.
 */
async function resumeAndSettle(h: ReturnType<typeof harness>, id: string, message: string, opts?: { origin?: typeof PERSON }): Promise<void> {
  void h.dispatcher.resume(id, message, opts);
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

/** A card already bound to its topic and in progress: the shape every automated resume works on. */
function boundCard(db: Database, id: string): void {
  const ts = new Date().toISOString();
  db.run("INSERT OR IGNORE INTO topics (id) VALUES (?)", [`topic-${id}`]);
  db.run(
    `INSERT INTO tasks (id, project_id, text, status, assigned_topic_id, created_at, updated_at, dispatch_attempts, priority)
     VALUES (?, ?, 'bound card', 'in_progress', ?, ?, ?, 1, 2)`,
    [id, PID, `topic-${id}`, ts, ts],
  );
}

describe("a resume while the project is paused", () => {
  test("an automated resume starts no turn, keeps the card in progress and reads project-paused", async () => {
    const h = harness();
    boundCard(h.db, "held");
    openPauseWithLimit(h.db, PID, 10.4);

    await resumeAndSettle(h, "held", "the checks went red, fix them");

    expect(h.turns).toHaveLength(0);
    const t = h.task("held");
    expect(t.status).toBe("in_progress");
    expect(t.assignedTopicId).toBe("topic-held");
    expect(t.dispatchState).toBe("queued");
    expect(t.queueReason).toMatchObject({ kind: "project-paused", tone: "waiting" });
  });

  test("a person's message is not held: the turn starts", async () => {
    const h = harness();
    boundCard(h.db, "person");
    openPauseWithLimit(h.db, PID, 10.4);

    await resumeAndSettle(h, "person", "go on please", { origin: PERSON });

    expect(h.turns).toHaveLength(1);
    expect(h.task("person").dispatchState).not.toBe("queued");
  });

  test("no pause, no hold: the same automated resume starts", async () => {
    const h = harness();
    boundCard(h.db, "free");

    await resumeAndSettle(h, "free", "the checks went red, fix them");

    expect(h.turns).toHaveLength(1);
  });

  test("after Continua the card that was waiting starts by itself", async () => {
    const h = harness();
    boundCard(h.db, "waiting");
    openPauseWithLimit(h.db, PID, 10.4);
    await resumeAndSettle(h, "waiting", "the checks went red, fix them");
    expect(h.turns).toHaveLength(0);

    // "Continua" closes the pause row, then announces it, as the route does.
    continueProject(h.db, PID, 10.4);
    fireProjectResumed(PID);
    // The retry is a background resume: let its microtasks settle.
    await settled(h.turns);

    expect(h.turns).toHaveLength(1);
    expect(h.turns[0]!.content).toContain("the checks went red, fix them");
    expect(h.task("waiting").status).toBe("in_progress");
    expect(h.task("waiting").dispatchState).not.toBe("queued");
  });

  test("a pause of ANOTHER project does not wake this one", async () => {
    const h = harness();
    boundCard(h.db, "stays");
    openPauseWithLimit(h.db, PID, 10.4);
    await resumeAndSettle(h, "stays", "the checks went red, fix them");

    fireProjectResumed("some-other-project");
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));

    expect(h.turns).toHaveLength(0);
  });
});
