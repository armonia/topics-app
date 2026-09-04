/**
 * `preserveWork`: a discarded attempt does not take its own commits with it.
 *
 * THE PATH THIS FILE EXISTS TO REACH, and why it needed a file of its own. The
 * regression that actually lost work is ONE agent, turn truncated, task put back
 * in `todo`, and the worktree deleted on the way out. Deleting a worktree deletes
 * the BRANCH too (`git branch -D`, WORKTREE-03), so an agent that had committed
 * and then had its turn cut by the infrastructure lost the commits.
 *
 * `task-dispatcher-fanout.test.ts` could not get here: its harness runs N
 * attempts, and every single-agent variant tried there landed somewhere else (in
 * `review` by system delivery, or without a worktree at all). Its own note says
 * so. The missing ingredient is not the turn, it is the CARD: a parent with an
 * open subtask in flight is sent back to `todo` by `deliverToReviewBySystem`,
 * which is the only cheap way to be in `todo` with a worktree already created.
 *
 * The harness is the one from `task-dispatcher.test.ts` with the two deps that
 * file never had: `deleteWorktree` (so a deletion is visible at all) and an
 * injectable `worktreeHasWork` (so the probe's answer is the variable).
 *
 * @covers KANBAN-07
 * @covers WORKTREE-09
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { createTaskService, type TaskService } from "./tasks";
import { createTaskDispatcher, type DispatcherDeps } from "./task-dispatcher";
import { cancelled, type TurnEndInfo } from "../providers/stop-reason";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL } from "../db/test-schema";

/** Self-contained schema: the same subset the other dispatcher harnesses build. */
function freshDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  db.run(TASKS_DDL);
  db.run(TASKS_FK_STUBS_DDL);
  db.run(TASK_LABELS_DDL); // migration 100: rowToTask reads it for EVERY task
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
/** `createWorktree` is handed the project store id, so this is the worktree's id. */
const WT = "wt-store-1";

let seq = 0;
function seedTask(
  db: Database,
  o: { id?: string; status?: string; parentTaskId?: string | null } = {},
): string {
  const id = o.id ?? `t${++seq}`;
  const ts = new Date(Date.now() + ++seq).toISOString();
  db.run(
    `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, parent_task_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, PID, "task " + id, o.status ?? "todo", ts, ts, o.parentTaskId ?? null],
  );
  return id;
}

function harness(overrides: Partial<DispatcherDeps> = {}) {
  const db = freshDb();
  const svc: TaskService = createTaskService(db);
  const events: unknown[] = [];
  const worktreesCreated: string[] = [];
  const worktreesDeleted: string[] = [];
  const topicsCreated: string[] = [];
  const turns: { sessionKey: string; content: string }[] = [];
  let resolveTurn: ((info?: TurnEndInfo) => void) | null = null;

  const deps: DispatcherDeps = {
    svc,
    // NO `attempts` store, on purpose: without it `fanOutOff` is true and the
    // dispatcher takes the SINGLE-agent path, which is the whole point here.
    //
    // NO `captureDelivery` and NO `uncommittedInWorktree`, for a sharper reason:
    // they are the only two `await`s between the end of the turn and
    // `deliverToReviewBySystem` inside the exhausted tail, which the dispatcher
    // fires as `void (async () => ...)()`. Leaving them out keeps that call
    // synchronous, so the card is ALREADY back in `todo` when `launch` reads the
    // status back and decides whether to clean the worktree up.
    resolveProject: () => ({ path: "/tmp/topics-preserve-work/alpha", projectStoreId: "store-1" }),
    createTopic: () => {
      const n = topicsCreated.length + 1;
      topicsCreated.push(`topic-${n}`);
      db.run("INSERT OR IGNORE INTO topics (id) VALUES (?)", [`topic-${n}`]);
      return { topicId: `topic-${n}`, sessionKey: `topic:sk${n}` };
    },
    createWorktree: async (storeId) => { worktreesCreated.push(storeId); return `wt-${storeId}`; },
    deleteWorktree: async (id) => { worktreesDeleted.push(id); },
    runTurn: (sessionKey, content) =>
      new Promise<TurnEndInfo | void>((res) => { turns.push({ sessionKey, content }); resolveTurn = res; }),
    broadcast: (m) => events.push(m),
    graceMs: 10,
    retryBackoffMs: 0, // instant harness turns must not wait out the outage backoff
    log: () => {},
    ...overrides,
  };
  const dispatcher = createTaskDispatcher(deps);
  return {
    db, svc, dispatcher, events, worktreesCreated, worktreesDeleted, turns,
    finishTurnWith: (info: TurnEndInfo) => { resolveTurn?.(info); },
    task: (id: string) => svc.get(id)?.task,
  };
}

const flush = async (n = 8) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

/**
 * A parent claimed, launched, and sitting on its LAST turn, with one subtask
 * still in flight. Three details are load-bearing:
 *
 *  - `dispatchRetryCap: 1`, and NOT a seeded attempt counter. `bindTopic`
 *    OVERWRITES `dispatch_attempts` to 1 on a fresh session, so whatever the row
 *    carried before the launch is gone by the time the turn starts. A cap of one
 *    is what makes this turn the last, and it sends the turn end straight to the
 *    "budget exhausted" tail instead of another retry on the same session.
 *  - the child is `in_progress` and NOT `todo`: a `todo` child counts as PARKED,
 *    and a parked child sends the parent to `review` with a question
 *    (`askParkedChildren`) instead of back to the queue. A child in flight is
 *    what makes `deliverToReviewBySystem` requeue the parent.
 *  - the agent's summary comment is written AFTER the tick, so it dates later
 *    than the `todo` to `in_progress` status event that marks the start of the
 *    turn. Without a fresh comment the tail parks the card in `backlog` instead.
 */
async function parentMidTurnWithSubtaskInFlight(h: ReturnType<typeof harness>): Promise<void> {
  h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: true, dispatchRetryCap: 1 });
  h.svc.setGlobalCap({ auto: false, max: 5 });
  seedTask(h.db, { id: "parent", status: "todo" });
  seedTask(h.db, { id: "step", status: "in_progress", parentTaskId: "parent" });
  await h.dispatcher.tick(PID);
  await flush();
  h.svc.addComment({
    taskId: "parent", author: "agent", kind: "comment",
    content: "Committed what I had, the subtask is still running.",
  });
}

describe("task-dispatcher preserveWork", () => {
  it("the worktree holds commits: requeue to todo does NOT delete it", async () => {
    const h = harness({ worktreeHasWork: async () => true });
    await parentMidTurnWithSubtaskInFlight(h);
    expect(h.worktreesCreated).toEqual(["store-1"]);

    h.finishTurnWith(cancelled("wall-clock"));
    await flush();

    // The route is asserted, not assumed: if a refactor stops sending the parent
    // back to the queue, this file must go RED instead of quietly testing a
    // branch it no longer reaches. That vacuity is exactly what sank the tests
    // this file replaces.
    const parent = h.task("parent");
    expect(parent?.status).toBe("todo");
    expect(parent?.dispatchError ?? "").toContain("sottotask ancora aperti");

    expect(h.worktreesDeleted).toEqual([]);
  });

  it("empty worktree: requeue to todo deletes it as before", async () => {
    const h = harness({ worktreeHasWork: async () => false });
    await parentMidTurnWithSubtaskInFlight(h);

    h.finishTurnWith(cancelled("wall-clock"));
    await flush();

    // The guard is not "never clean up": nothing to lose means the worktree goes,
    // otherwise every retry would strand another checkout on disk.
    expect(h.task("parent")?.status).toBe("todo");
    expect(h.worktreesDeleted).toEqual([WT]);
  });

  it("the probe throws: it does NOT authorise destroying", async () => {
    const h = harness({
      worktreeHasWork: async () => { throw new Error("index.lock"); },
    });
    await parentMidTurnWithSubtaskInFlight(h);

    h.finishTurnWith(cancelled("wall-clock"));
    await flush();

    // Not knowing is not permission: a git probe that cannot answer counts as
    // dirty, never as clean (WORKTREE-09, same rule as the sweep).
    expect(h.task("parent")?.status).toBe("todo");
    expect(h.worktreesDeleted).toEqual([]);
  });
});
