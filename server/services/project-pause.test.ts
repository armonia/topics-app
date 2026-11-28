/**
 * The project quota brake: default limit, the two confirmations, fail-open.
 * @covers USAGE-29
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { storedLimit } from "../usage/project-limit";
import {
  CONTINUE_GRACE_PCT, continueProject, nextLocalMidnight, openPauseIfNeeded,
  pauseState, pauseUntilTomorrow, projectIsPaused, reconcilePause, projectPauseInfo, readProjectQuotaRow, setProjectLimit,
} from "./project-pause";
import { createTaskService, type TaskService } from "./tasks";
import { createTaskDispatcher, type DispatcherDeps } from "./task-dispatcher";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL } from "../db/test-schema";

const MIGRATION = await Bun.file(join(import.meta.dir, "../db/migrations/20261119000000-project-quota.sql")).text();

function makeDb(): Database {
  const db = new Database(":memory:");
  db.exec(MIGRATION);
  // Until 64b1f052 a project with no row has no limit, so the brake tests start
  // from an explicit row at 10 points.
  db.run("INSERT INTO project_quota (project_id, limit_24h_pct, updated_at) VALUES ('p', 10, 'x')");
  return db;
}

describe("pauseState", () => {
  test("a project with a row at 10 points pauses above it; no row means no limit", () => {
    const row = { projectId: "p", limit24hPct: 10, pausedAt: null, continuedUntilPct: null, holdUntil: null };
    expect(pauseState(row, 10.4).paused).toBe(true);
    expect(pauseState(row, 10.4).reason).toBe("limit");
    expect(pauseState(row, 9.9).paused).toBe(false);
    expect(pauseState(null, 35).paused).toBe(false);
  });

  test("a read that could not be trusted (null points) never pauses — fail open", () => {
    expect(pauseState(null, null).paused).toBe(false);
  });

  test("'Nessuno' (limit24hPct: null on an existing row) removes the limit", () => {
    const row = { projectId: "p", limit24hPct: null, limitNone: true, pausedAt: null, continuedUntilPct: null, holdUntil: null };
    expect(pauseState(row, 90).paused).toBe(false);
  });

  test("a continuation ceiling covers the project until it is reached again", () => {
    const row = { projectId: "p", limit24hPct: 10, pausedAt: null, continuedUntilPct: 20.4, holdUntil: null };
    expect(pauseState(row, 15).paused).toBe(false); // covered
    expect(pauseState(row, 20.4).paused).toBe(true); // ceiling reached: the confirmation returns
  });

  test("'Pausa fino a domani' pauses regardless of points until local midnight", () => {
    const midnight = nextLocalMidnight(1_700_000_000_000);
    const row = { projectId: "p", limit24hPct: 10, pausedAt: "x", continuedUntilPct: null, holdUntil: midnight };
    expect(pauseState(row, 0, 1_700_000_000_000 + 1000).paused).toBe(true);
    expect(pauseState(row, 0, midnight + 1000).paused).toBe(false); // past midnight, points decide again
  });
});

describe("the brake's writes", () => {
  test("openPauseIfNeeded opens once, and reports only the first time", () => {
    const db = makeDb();
    expect(openPauseIfNeeded(db, "p", 10.4)).toBe(true);
    expect(readProjectQuotaRow(db, "p")?.pausedAt).toBeTruthy();
    expect(openPauseIfNeeded(db, "p", 10.4)).toBe(false); // already open
  });

  test("continueProject clears the pause and buys CONTINUE_GRACE_PCT more points", () => {
    const db = makeDb();
    openPauseIfNeeded(db, "p", 10.4);
    continueProject(db, "p", 10.4);
    const row = readProjectQuotaRow(db, "p")!;
    expect(row.pausedAt).toBeNull();
    expect(row.continuedUntilPct).toBeCloseTo(10.4 + CONTINUE_GRACE_PCT, 5);
    expect(pauseState(row, 10.4).paused).toBe(false);
    expect(pauseState(row, 20.4).paused).toBe(true); // the confirmation returns
  });

  test("pauseUntilTomorrow sets hold_until to local midnight", () => {
    const db = makeDb();
    const before = Date.now();
    pauseUntilTomorrow(db, "p", before);
    const row = readProjectQuotaRow(db, "p")!;
    expect(row.holdUntil).toBe(nextLocalMidnight(before));
  });

  test("setProjectLimit(null) writes 'Nessuno' even on a project never configured before", () => {
    const db = makeDb();
    setProjectLimit(db, "p", null);
    const row = readProjectQuotaRow(db, "p")!;
    expect(row.limit24hPct).toBeNull();
    expect(pauseState(row, 90).paused).toBe(false);
  });
});

describe("projectIsPaused — the per-tick gate's cheap check", () => {
  test("reads the materialized pausedAt set by openPauseIfNeeded, with no points", () => {
    const db = makeDb();
    expect(projectIsPaused(db, "p")).toBe(false);
    openPauseIfNeeded(db, "p", 10.4);
    expect(projectIsPaused(db, "p")).toBe(true);
    continueProject(db, "p", 10.4);
    expect(projectIsPaused(db, "p")).toBe(false);
  });

  test("null project id and a closed db both fail open", () => {
    const db = makeDb();
    expect(projectIsPaused(db, null)).toBe(false);
    db.close();
    expect(projectIsPaused(db, "p")).toBe(false);
  });
});

describe("the pause CLOSES: what every gate reads (projectIsPaused) flips back", () => {
  const T0 = 1_700_000_000_000;

  test("Continua", () => {
    const db = makeDb();
    openPauseIfNeeded(db, "p", 50, T0);
    expect(projectIsPaused(db, "p", T0)).toBe(true);
    continueProject(db, "p", 50);
    expect(projectIsPaused(db, "p", T0)).toBe(false);
  });

  test("midnight after 'Pausa fino a domani', even with the points still over the limit", () => {
    const db = makeDb();
    pauseUntilTomorrow(db, "p", T0);
    const midnight = nextLocalMidnight(T0);
    expect(projectIsPaused(db, "p", midnight - 1)).toBe(true);
    // The gate honours the hold's own end before any sweep has run.
    expect(projectIsPaused(db, "p", midnight + 1)).toBe(false);
    // The sweep then reopens it only if the project is still over its limit.
    expect(reconcilePause(db, "p", 50, midnight + 1)).toBeNull();
    expect(projectIsPaused(db, "p", midnight + 1)).toBe(true);
  });

  test("midnight with the points back under the limit: the sweep closes it", () => {
    const db = makeDb();
    pauseUntilTomorrow(db, "p", T0);
    const midnight = nextLocalMidnight(T0);
    expect(reconcilePause(db, "p", 2, midnight + 1)).toBe("closed");
    expect(projectIsPaused(db, "p", midnight + 1)).toBe(false);
  });

  test("limit removed ('Nessuno') or raised above the consumption", () => {
    const db = makeDb();
    openPauseIfNeeded(db, "p", 30, T0);
    setProjectLimit(db, "p", null);
    expect(reconcilePause(db, "p", 30, T0)).toBe("closed");
    expect(projectIsPaused(db, "p", T0)).toBe(false);

    const db2 = makeDb();
    openPauseIfNeeded(db2, "p", 30, T0);
    setProjectLimit(db2, "p", 40);
    expect(reconcilePause(db2, "p", 30, T0)).toBe("closed");
    expect(projectIsPaused(db2, "p", T0)).toBe(false);
  });

  test("the window falls back under the limit", () => {
    const db = makeDb();
    openPauseIfNeeded(db, "p", 12, T0);
    expect(reconcilePause(db, "p", 12, T0)).toBeNull(); // still over: stays paused
    expect(projectIsPaused(db, "p", T0)).toBe(true);
    expect(reconcilePause(db, "p", 6, T0)).toBe("closed");
    expect(projectIsPaused(db, "p", T0)).toBe(false);
  });
});

describe("a row the brake creates itself", () => {
  test("hold and continue on a project with no row leave the limit unset, never 'None'", () => {
    const db = makeDb();
    pauseUntilTomorrow(db, "fresh", 1_700_000_000_000);
    expect(readProjectQuotaRow(db, "fresh")?.limitNone).toBe(false);
    expect(readProjectQuotaRow(db, "fresh")?.limit24hPct).toBeNull();
    expect(storedLimit(readProjectQuotaRow(db, "fresh")!.limit24hPct, 0)).toBeUndefined();
    continueProject(db, "fresh2", 5);
    expect(readProjectQuotaRow(db, "fresh2")?.limitNone).toBe(false);
  });

  test("a person's 'None' is kept apart, and survives a pause confirmation", () => {
    const db = makeDb();
    setProjectLimit(db, "p", null);
    continueProject(db, "p", 5);
    expect(readProjectQuotaRow(db, "p")?.limitNone).toBe(true);
    expect(storedLimit(null, 1)).toBeNull();
  });
});

describe("projectPauseInfo", () => {
  test("a project never configured has no limit and is not stopped at 35 points", () => {
    const db = makeDb();
    const info = projectPauseInfo(db, "q", 35);
    expect(info.limit).toBeNull();
    expect(info.paused).toBe(false);
    expect(openPauseIfNeeded(db, "q", 35, 1_700_000_000_000)).toBe(false);
    expect(projectIsPaused(db, "q", 1_700_000_000_000)).toBe(false);
  });

  test("a project with an explicit row at 10 stops at 35 points and Continue releases it", () => {
    const db = makeDb();
    setProjectLimit(db, "r", 10);
    const T = 1_700_000_000_000;
    expect(openPauseIfNeeded(db, "r", 35, T)).toBe(true);
    expect(projectIsPaused(db, "r", T)).toBe(true);
    continueProject(db, "r", 35);
    expect(projectIsPaused(db, "r", T)).toBe(false);
  });

  test("a DB error fails open with no limit and no pause", () => {
    const db = makeDb();
    db.close(); // every query on a closed db throws
    const info = projectPauseInfo(db, "p", 50);
    expect(info.paused).toBe(false);
    expect(info.limit).toBeNull();
  });
});

describe("integrazione: il freno nel dispatcher (USAGE-29)", () => {
  // Same harness shape as task-dispatcher-spend-cap.test.ts's `harness()`, the
  // analogous brake already measured that way: a real `createTaskService` +
  // `createTaskDispatcher`, ticked, with the project_quota table alongside
  // the usual board tables.
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

  const PID = "paused-project-abc123";
  let seq = 0;
  function seedTask(db: Database, id: string): void {
    const ts = new Date(Date.now() + ++seq).toISOString();
    db.run(
      `INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, dispatch_attempts, priority)
       VALUES (?, ?, ?, 'todo', ?, ?, 0, 2)`,
      [id, PID, "task " + id, ts, ts],
    );
  }

  function harness() {
    const db = freshDb();
    db.run("INSERT INTO project_quota (project_id, limit_24h_pct, updated_at) VALUES (?, 10, 'x')", [PID]);
    const svc: TaskService = createTaskService(db);
    const turns: { sessionKey: string; content: string }[] = [];
    const deps: DispatcherDeps = {
      svc,
      resolveProject: () => ({ path: "/tmp/paused", projectStoreId: "store-1" }),
      createTopic: () => {
        const n = turns.length + 1;
        db.run("INSERT OR IGNORE INTO topics (id) VALUES (?)", [`t-${n}`]);
        return { topicId: `t-${n}`, sessionKey: `topic:sk${n}` };
      },
      archiveTopic: () => {},
      getLastAgentText: () => ({ text: "summary", id: "m-summary" }),
      runTurn: (sessionKey, content) => { turns.push({ sessionKey, content }); return Promise.resolve(); },
      broadcast: () => {},
      graceMs: 0,
      retryBackoffMs: 0,
      log: () => {},
    };
    const dispatcher = createTaskDispatcher(deps);
    return {
      db, svc, dispatcher, turns,
      task: (id: string) => svc.get(id)?.task,
      pauseNotes: (id: string) =>
        (svc.get(id)?.comments ?? []).filter((c) => c.content.includes("In pausa: limite del progetto")).length,
    };
  }

  function board(h: ReturnType<typeof harness>): void {
    h.svc.updateBoardSettings(PID, { autoDispatch: true, dispatchUseWorktree: false });
    h.svc.setGlobalCap({ auto: false, max: 4 });
  }

  test("una card del progetto in pausa resta in todo col motivo, e lo dice una volta", async () => {
    const h = harness();
    board(h);
    openPauseIfNeeded(h.db, PID, 10.4);
    seedTask(h.db, "p1");

    for (let i = 0; i < 3; i++) { await h.dispatcher.tick(PID); await new Promise((r) => setTimeout(r, 0)); }

    expect(h.task("p1")!.status).toBe("todo");
    expect(h.pauseNotes("p1")).toBe(1);
  });

  test("un progetto non in pausa parte normalmente", async () => {
    const h = harness();
    board(h);
    seedTask(h.db, "p2");

    for (let i = 0; i < 3; i++) { await h.dispatcher.tick(PID); await new Promise((r) => setTimeout(r, 0)); }

    expect(h.pauseNotes("p2")).toBe(0);
  });
});
