/**
 * THE CARD THE HUMAN MOVED WHILE THE AGENT WAS STILL WORKING.
 *
 * `onTurnEnd` has one branch for it: the card is no longer `in_progress` and no
 * longer `review`, so it is not ours any more and we get out of the way. That
 * branch used to do exactly one thing, unconditionally: drop our chip. Which is
 * right for a turn the agent CLOSED by itself, and wrong for a turn that FAILED
 * — the failure had no other place to live, so it was erased in silence and the
 * card sat there looking untouched: "I moved it to backlog, it failed, and
 * nothing happened".
 *
 * The harness is the small one the other dispatcher files use: a real service
 * over an in-memory schema, a turn that resolves when the test says so.
 *
 * @covers KANBAN-07
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { createTaskService, type TaskService } from "./tasks";
import { createTaskDispatcher, type DispatcherDeps } from "./task-dispatcher";
import { cancelled, type TurnEndInfo } from "../providers/stop-reason";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL } from "../db/test-schema";

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
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
    review_checks TEXT,
    max_agents_auto INTEGER, dispatch_fanout INTEGER,
    dispatch_paused INTEGER NOT NULL DEFAULT 0
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
    rubric_scores TEXT, situation TEXT, justification TEXT, status TEXT NOT NULL DEFAULT 'pending',
    reviewed_by TEXT, review_comment TEXT, created_at TEXT NOT NULL, reviewed_at TEXT, expires_at TEXT
  )`);
  return db;
}

const PID = "alpha-abc123";

function harness(overrides: Partial<DispatcherDeps> = {}) {
  const db = freshDb();
  const svc: TaskService = createTaskService(db);
  const events: Array<{ type?: string; state?: string }> = [];
  let resolveTurn: ((info?: TurnEndInfo) => void) | null = null;

  const deps: DispatcherDeps = {
    svc,
    resolveProject: () => ({ path: "/tmp/topics-moved-mid-turn/alpha", projectStoreId: "store-1" }),
    createTopic: () => {
      db.run("INSERT OR IGNORE INTO topics (id) VALUES (?)", ["topic-1"]);
      return { topicId: "topic-1", sessionKey: "topic:sk1" };
    },
    createWorktree: async () => "wt-store-1",
    deleteWorktree: async () => {},
    runTurn: () => new Promise<TurnEndInfo | void>((res) => { resolveTurn = res; }),
    broadcast: (m) => events.push(m as { type?: string; state?: string }),
    graceMs: 10,
    retryBackoffMs: 0,
    log: () => {},
    ...overrides,
  };
  const dispatcher = createTaskDispatcher(deps);
  return {
    db, svc, dispatcher, events,
    finishTurnWith: (info: TurnEndInfo) => { resolveTurn?.(info); },
    task: (id: string) => svc.get(id)?.task,
    comments: (id: string) => svc.get(id)?.comments ?? [],
  };
}

const flush = async (n = 8) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

/** A claimed task with a live turn, that the human then drags to `backlog`. */
async function movedToBacklogMidTurn(h: ReturnType<typeof harness>): Promise<void> {
  h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: false });
  h.svc.setGlobalCap({ auto: false, max: 5 });
  const ts = new Date().toISOString();
  h.db.run(
    "INSERT INTO tasks (id, project_id, text, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ["t1", PID, "task t1", "todo", ts, ts],
  );
  await h.dispatcher.tick(PID);
  await flush();
  expect(h.task("t1")?.status).toBe("in_progress");
  h.svc.update({ taskId: "t1", actor: "human", by: "user", patch: { status: "backlog" } });
}

describe("task-dispatcher: card moved by hand while the turn was running", () => {
  it("a FAILED turn stays visible: chip, reason and a comment in the thread", async () => {
    const h = harness();
    await movedToBacklogMidTurn(h);

    h.finishTurnWith({ end: "error", cause: "provider-error" });
    await flush();

    const t = h.task("t1");
    expect(t?.status).toBe("backlog");
    expect(t?.dispatchState).toBe("failed");
    expect(t?.dispatchError ?? "").toContain("spostata a mano");
    expect(h.comments("t1").some((c) => (c.content ?? "").includes("spostata a mano"))).toBe(true);
    // The board's failure front, the same one every other park raises: without
    // it the chip exists but nobody is told it appeared.
    expect(h.events.some((e) => e.type === "task:parked" && e.state === "failed")).toBe(true);
  });

  it("a turn the agent closed by itself just drops the chip", async () => {
    const h = harness();
    await movedToBacklogMidTurn(h);

    h.finishTurnWith({ end: "end_turn" });
    await flush();

    expect(h.task("t1")?.dispatchState).toBeNull();
    expect(h.events.some((e) => e.type === "task:parked")).toBe(false);
  });

  it("a stop by hand costs nothing, so it leaves no chip", async () => {
    const h = harness();
    await movedToBacklogMidTurn(h);

    // `consumesAttempt` is the line: what does not burn a retry is not the
    // agent's failure either, and a chip on it would be noise on a card that
    // restarts by itself.
    h.finishTurnWith(cancelled("user"));
    await flush();

    expect(h.task("t1")?.dispatchState).toBeNull();
  });
});
