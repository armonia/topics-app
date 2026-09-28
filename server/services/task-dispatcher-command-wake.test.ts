/**
 * A BOARD CARD WHOSE AGENT ENDS ITS TURN ON A RUNNING `run_command`.
 *
 * The prompt and the tool's own result tell every agent, board agents
 * included, to end its turn once `run_command` is started: the command wakes
 * the topic when it ends (`lib/process-exit-wake.ts`). The dispatcher read
 * that end as an interrupted turn: a continuation nudge over the running
 * command and an attempt spent, and with the default cap of 2 the card left
 * `in_progress` (parked «failed») before the command ended. Reproduced by
 * both verifiers of 28/09 at 0252f6ea5.
 *
 * Here the two probes the host wires (`awaitsCommandWake`, `isSessionBusy`)
 * are plain flags: the real ones meet the real registry and chat route in
 * `tests/integration/process-run-command.test.ts`.
 *
 * @covers CMDRUN-04
 */
import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { Database } from "bun:sqlite";
import { createTaskService, type TaskService } from "./tasks";
import { createTaskDispatcher, type DispatcherDeps } from "./task-dispatcher";
import { createTaskAttemptStore } from "./task-attempts";
import { BACKGROUND_WORK_CAP_MS } from "../providers/claude/background-work";
import type { TurnEndInfo } from "../providers/stop-reason";
import { APP_SETTINGS_DDL, TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL } from "../db/test-schema";

const PID = "alpha-abc123";

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  db.run(`CREATE TABLE topics (id TEXT PRIMARY KEY)`);
  db.run(TASKS_DDL);
  db.run(TASKS_FK_STUBS_DDL);
  db.run(TASK_LABELS_DDL);
  db.run(APP_SETTINGS_DDL);
  db.run(`CREATE TABLE board_settings (
    project_id TEXT PRIMARY KEY, require_approval_for_done INTEGER DEFAULT 0,
    require_review_before_done INTEGER DEFAULT 0, block_status_with_pending INTEGER DEFAULT 0,
    only_lead_can_change_status INTEGER DEFAULT 0, max_agents INTEGER DEFAULT 5, auto_expire_hours INTEGER DEFAULT 24,
    auto_dispatch INTEGER NOT NULL DEFAULT 0, dispatch_effort TEXT NOT NULL DEFAULT 'medium', dispatch_model TEXT,
    dispatch_use_worktree INTEGER NOT NULL DEFAULT 1, dispatch_timeout_min INTEGER NOT NULL DEFAULT 20,
    dispatch_idle_min INTEGER NOT NULL DEFAULT 5, dispatch_mcp TEXT,
    dispatch_retry_cap INTEGER, dispatch_retry_backoff_s INTEGER, review_checks TEXT,
    max_agents_auto INTEGER, dispatch_fanout INTEGER, dispatch_paused INTEGER NOT NULL DEFAULT 0
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
  return db;
}

/** The session's side, as the host's probes read it. */
interface Session { owed: boolean; busy: boolean }

function bench(session: Session) {
  const db = freshDb();
  const svc: TaskService = createTaskService(db);
  const turns: string[] = [];
  let endTurn: ((info: TurnEndInfo) => void) | null = null;
  const deps: DispatcherDeps = {
    svc,
    attempts: createTaskAttemptStore(db),
    resolveProject: () => ({ path: "/tmp/alpha", projectStoreId: "store-1" }),
    createTopic: () => {
      db.run("INSERT OR IGNORE INTO topics (id) VALUES ('topic-1')");
      return { topicId: "topic-1", sessionKey: "topic:topic-1" };
    },
    createWorktree: async () => "wt-1",
    topicExists: () => true,
    runTurn: (_sessionKey, content) =>
      new Promise<TurnEndInfo | void>((res) => { turns.push(content); endTurn = res; }),
    awaitsCommandWake: () => session.owed,
    isSessionBusy: () => session.busy,
    broadcast: () => {},
    graceMs: 0,
    retryBackoffMs: 0,
    log: () => {},
  };
  svc.updateBoardSettings(PID, { autoDispatch: true });
  return {
    db, svc, turns, deps,
    dispatcher: createTaskDispatcher(deps),
    endTurn: (info: TurnEndInfo = { end: "end_turn" }) => endTurn?.(info),
    task: () => svc.get("t1")!.task,
    notes: () => svc.get("t1")!.comments.filter((c) => c.author === "system").map((c) => c.content),
  };
}

const flush = async (n = 12) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

function seedTodo(db: Database): void {
  const ts = new Date().toISOString();
  db.run(
    `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, dispatch_attempts)
     VALUES ('t1', ?, 'task t1', 'todo', ?, ?, 0)`,
    [PID, ts, ts],
  );
}

/** Its first turn launched, and ended by the agent while its command runs. */
async function endedOnCommand(session: Session) {
  const b = bench(session);
  seedTodo(b.db);
  await b.dispatcher.tick(PID);
  await flush();
  expect(b.turns.length).toBe(1);
  b.endTurn();
  await flush();
  return b;
}

/** Poll passes as the host runs them, far enough apart for the orphan grace to be over. */
async function polls(b: ReturnType<typeof bench>, n: number, stepMs = 5 * 60_000) {
  for (let i = 0; i < n; i++) {
    setSystemTime(new Date(Date.now() + stepMs));
    await b.dispatcher.reconcile({ reason: "poll" });
    await flush();
  }
}

afterEach(() => setSystemTime());

describe("a card whose agent ended its turn on a running run_command", () => {
  it("is not nudged, spends no attempt, and the poll leaves it waiting", async () => {
    const session = { owed: true, busy: false };
    const b = await endedOnCommand(session);
    expect(b.turns.length).toBe(1);
    expect(b.task().dispatchAttempts).toBe(1);
    expect(b.task().status).toBe("in_progress");
    // The orphan pass sees an in_progress card with no turn of ours: past its
    // grace it used to wake it anyway.
    await polls(b, 3);
    expect(b.turns.length).toBe(1);
    expect(b.task().dispatchAttempts).toBe(1);
    expect(b.task().status).toBe("in_progress");
    // One line says why nothing moves, not one per pass.
    expect(b.notes().filter((n) => n.includes("run_command")).length).toBe(1);
    b.dispatcher.shutdown();
  });

  it("waits through the wake's turn, then continues as after any turn that did not deliver", async () => {
    const session = { owed: true, busy: false };
    const b = await endedOnCommand(session);
    // The command ended and its wake row opened a turn on the session.
    session.owed = false;
    session.busy = true;
    await polls(b, 2);
    expect(b.turns.length).toBe(1);
    // That turn ended without taking the card to review.
    session.busy = false;
    await polls(b, 1);
    expect(b.turns.length).toBe(2);
    expect(b.task().dispatchAttempts).toBe(2);
    expect(b.task().status).toBe("in_progress");
    b.dispatcher.shutdown();
  });

  it("proceeds to review when the wake's turn delivers, without a nudge", async () => {
    const session = { owed: true, busy: false };
    const b = await endedOnCommand(session);
    session.owed = false;
    session.busy = true;
    // The agent, woken, delivers from the wake's turn.
    b.svc.addComment({ taskId: "t1", author: "claude", content: "fatto, il comando e' uscito con 0" });
    b.svc.update({ taskId: "t1", actor: "agent", by: "claude", patch: { status: "review", summary: "riassunto" } });
    await polls(b, 1);
    session.busy = false;
    await polls(b, 1);
    expect(b.turns.length).toBe(1);
    expect(b.task().status).toBe("review");
    expect(b.task().dispatchState).toBe("delivered");
    b.dispatcher.shutdown();
  });

  it("waits again when the wake's turn starts another command", async () => {
    const session = { owed: true, busy: false };
    const b = await endedOnCommand(session);
    session.owed = false;
    session.busy = true;
    await polls(b, 1);
    session.owed = true;
    session.busy = false;
    await polls(b, 3);
    expect(b.turns.length).toBe(1);
    expect(b.task().dispatchAttempts).toBe(1);
    b.dispatcher.shutdown();
  });

  it("is bounded by the background-work cap: past it the card continues once, then waits again", async () => {
    const session = { owed: true, busy: false };
    const b = await endedOnCommand(session);
    await polls(b, 1, BACKGROUND_WORK_CAP_MS - 60_000);
    expect(b.turns.length).toBe(1);
    await polls(b, 1, 2 * 60_000);
    expect(b.turns.length).toBe(2);
    expect(b.task().dispatchAttempts).toBe(2);
    // The continuation ends on the command still running: a new wait.
    b.endTurn();
    await flush();
    await polls(b, 2);
    expect(b.turns.length).toBe(2);
    expect(b.task().status).toBe("in_progress");
    b.dispatcher.shutdown();
  });

  it("waits again after a restart instead of resuming over the command", async () => {
    const session = { owed: true, busy: false };
    const b = await endedOnCommand(session);
    b.dispatcher.shutdown();
    const next = createTaskDispatcher(b.deps);
    await next.reconcile({ reason: "boot" });
    await flush();
    expect(b.turns.length).toBe(1);
    expect(b.task().status).toBe("in_progress");
    expect(b.task().dispatchAttempts).toBe(1);
    // The command ends and its wake's turn runs and ends: the card goes on.
    session.owed = false;
    setSystemTime(new Date(Date.now() + 5 * 60_000));
    await next.reconcile({ reason: "poll" });
    await flush();
    expect(b.turns.length).toBe(2);
    next.shutdown();
  });
});
