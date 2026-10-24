/**
 * The two sweeps that `[DB-SLOW]` named on the live server (15/10/2026) read
 * only the rows they need: the boot sweep through the partial index of the
 * half-written messages, the resume sweep through the timestamp index. Checked
 * on the real schema (all migrations) and on the SQL the code runs.
 *
 * The reads of `tasks` on a timer (dispatcher tick, wait sweep, status bar) go
 * through their partial indexes instead of the whole table.
 *
 * @covers DBSLOW-02
 * @covers DBSLOW-03
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, initDatabase } from "./db";
import { PARTIAL_SESSIONS_SQL } from "./lib/boot-partial-sweep";
import { LAST_RECENT_MESSAGES_SQL } from "./lib/ripresa-boot";
import {
  CHECKS_RUNNING_SQL,
  OLDEST_WORKING_BOARD_SQL,
  PARKED_CHILDREN_CANDIDATES_SQL,
  PARKED_IN_SERIES_SQL,
  QUEUED_ROOT_BOARDS_SQL,
  WORKING_TASKS_COUNT_SQL,
} from "./lib/task-timer-reads";

/** The resume query before 15/10/2026, verbatim: the reference for the rows. */
const LAST_MESSAGE_OF_EVERY_CHAT_SQL = `SELECT m.session_key AS sk, m.id AS id, m.role AS ruolo, m.blocks AS blocks, m.timestamp AS ts
         FROM messages m
         JOIN (SELECT session_key, MAX(rowid) AS r FROM messages GROUP BY session_key) u
           ON u.r = m.rowid
        WHERE m.timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-25 hours')`;

/**
 * The stuck-parents read before 24/10/2026, verbatim: the reference for the
 * rows. `NOT IN (...)` hides the status from the partial index; the table's own
 * CHECK(status IN ('backlog', 'todo', 'in_progress', 'review', 'done')) is what
 * makes `IN ('backlog', 'todo')` the same set.
 */
const PARKED_CHILDREN_NOT_IN_SQL = `SELECT p.id, p.project_id FROM tasks p
            WHERE p.archived = 0
              AND p.status NOT IN ('done', 'review', 'in_progress')
              AND NOT (p.status = 'todo' AND p.dispatch_attempts = 0)
              AND COALESCE(p.dispatch_state, '') NOT IN ('queued', 'starting', 'working')
              AND COALESCE(p.dispatch_deferred_until, '') <= ?
              AND EXISTS (SELECT 1 FROM tasks c
                           WHERE c.parent_task_id = p.id AND c.archived = 0 AND c.status != 'done')
            ORDER BY p.updated_at`;

let tmpRoot: string;
let db: Database;

const plan = (sql: string): string[] =>
  (db.query(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((r) => r.detail);

const bySession = (rows: unknown[]) =>
  (rows as Array<{ sk: string; id: string }>).map((r) => `${r.sk}:${r.id}`).sort();

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "sweep-plans-test-"));
  const migDir = join(tmpRoot, "server", "db", "migrations");
  mkdirSync(migDir, { recursive: true });
  const realMigDir = join(import.meta.dir, "db", "migrations");
  for (const f of readdirSync(realMigDir)) {
    if (f.endsWith(".sql")) writeFileSync(join(migDir, f), readFileSync(join(realMigDir, f), "utf-8"));
  }
  db = initDatabase(tmpRoot);

  const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  const insert = db.prepare("INSERT INTO messages (id, session_key, role, timestamp, partial) VALUES (?, ?, 'user', ?, ?)");
  db.transaction(() => {
    // The live shape: thousands of old messages over hundreds of chats.
    for (let chat = 0; chat < 300; chat++) {
      for (let i = 0; i < 10; i++) insert.run(`old-${chat}-${i}`, `chat-${chat}`, daysAgo(30), 0);
    }
    insert.run("a-old", "recent-a", daysAgo(3), 0);
    insert.run("a-new", "recent-a", daysAgo(0.1), 0);
    insert.run("b-new", "recent-b", daysAgo(0.5), 0);
    // A recent row first, then an older one: its LAST row by rowid is old, so
    // the chat is out, as it was before.
    insert.run("c-recent", "old-last", daysAgo(0.2), 0);
    insert.run("c-older", "old-last", daysAgo(5), 0);
    insert.run("p-half", "partial-chat", daysAgo(40), 1);
  })();
});

afterAll(() => {
  try { closeDatabase(); } catch { /* already closed */ }
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("boot sweep", () => {
  test("finds the half-written chats through the partial index", () => {
    expect(plan(PARTIAL_SESSIONS_SQL).join(" / ")).toContain("idx_messages_partial");
    expect(db.query(PARTIAL_SESSIONS_SQL).all()).toEqual([{ sk: "partial-chat" }]);
  });
});

describe("resume sweep", () => {
  test("starts from the recent messages, never from every chat", () => {
    const steps = plan(LAST_RECENT_MESSAGES_SQL);
    expect(steps.join(" / ")).toContain("idx_messages_timestamp");
    expect(steps.filter((s) => /^SCAN (messages|m)\b/.test(s))).toEqual([]);
  });

  test("returns the same rows as the query it replaced", () => {
    const now = bySession(db.query(LAST_RECENT_MESSAGES_SQL).all());
    expect(now).toEqual(bySession(db.query(LAST_MESSAGE_OF_EVERY_CHAT_SQL).all()));
    expect(now).toEqual(["recent-a:a-new", "recent-b:b-new"]);
  });
});

describe("tasks reads on a timer", () => {
  test.each([
    ["dispatcher tick", QUEUED_ROOT_BOARDS_SQL, "idx_tasks_queued_roots"],
    ["working count", WORKING_TASKS_COUNT_SQL, "idx_tasks_working"],
    ["oldest working board", OLDEST_WORKING_BOARD_SQL, "idx_tasks_working"],
    ["wait sweep", PARKED_IN_SERIES_SQL, "idx_tasks_waiting"],
  ])("%s reads its partial index, not the table", (_name, sql, index) => {
    const steps = plan(sql);
    expect(steps.join(" / ")).toContain(index);
    expect(steps.filter((s) => /^SCAN (tasks|t)$/.test(s))).toEqual([]);
  });
});

describe("tasks reads on a timer: the stale checks light and the stuck parents", () => {
  test("the running checks light reads its partial index, not the table", () => {
    const steps = plan(CHECKS_RUNNING_SQL);
    expect(steps.join(" / ")).toContain("idx_tasks_checks_running");
    // A covering scan of the small partial index is fine; a bare table scan is not.
    expect(steps.filter((s) => /^SCAN tasks$/.test(s))).toEqual([]);
  });

  test("the stuck parents start from their partial index, with no sort", () => {
    const steps = plan(PARKED_CHILDREN_CANDIDATES_SQL);
    // Only the outer step is pinned: the EXISTS subquery may use idx_tasks_archived.
    expect(steps).toContain("SEARCH p USING INDEX idx_tasks_parked_candidates (archived=?)");
    expect(steps.filter((s) => s.startsWith("SEARCH p USING INDEX idx_tasks_archived"))).toEqual([]);
    expect(steps.filter((s) => s.includes("USE TEMP B-TREE FOR ORDER BY"))).toEqual([]);
  });

  test("both reads return the same rows as the queries they replace", () => {
    const stamp = new Date().toISOString();
    const insert = db.prepare(
      `INSERT INTO tasks (id, project_id, text, status, archived, parent_task_id, dispatch_state,
                          dispatch_attempts, dispatch_deferred_until, checks_state, created_at, updated_at)
       VALUES (?, 'p1', 'x', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    try {
      db.transaction(() => {
        // One parent per status, archived or not, each with one open child.
        for (const st of ["backlog", "todo", "in_progress", "review", "done"]) {
          insert.run(`par-${st}`, st, 0, null, null, 1, null, null, stamp, stamp);
          insert.run(`par-${st}-arch`, st, 1, null, null, 1, null, null, stamp, stamp);
          insert.run(`kid-${st}`, "todo", 0, `par-${st}`, null, 0, null, null, stamp, stamp);
          insert.run(`kid-${st}-arch`, "todo", 0, `par-${st}-arch`, null, 0, null, null, stamp, stamp);
        }
        // A fresh queued parent (no attempt spent) is waiting for its turn, not stuck.
        insert.run("par-fresh-todo", "todo", 0, null, null, 0, null, null, stamp, stamp);
        insert.run("kid-fresh-todo", "todo", 0, "par-fresh-todo", null, 0, null, null, stamp, stamp);
        // A backlog parent with a live agent chip, and one deferred into the future.
        insert.run("par-working", "backlog", 0, null, "working", 1, null, null, stamp, stamp);
        insert.run("kid-working", "todo", 0, "par-working", null, 0, null, null, stamp, stamp);
        insert.run("par-deferred", "backlog", 0, null, null, 1, "9999-01-01T00:00:00.000Z", null, stamp, stamp);
        insert.run("kid-deferred", "todo", 0, "par-deferred", null, 0, null, null, stamp, stamp);
        // The checks light: running, finished, and never run.
        insert.run("chk-running", "review", 0, null, null, 0, null, "running", stamp, stamp);
        insert.run("chk-passed", "review", 0, null, null, 0, null, "passed", stamp, stamp);
        insert.run("chk-none", "review", 0, null, null, 0, null, null, stamp, stamp);
      })();

      const parked = (sql: string) =>
        (db.query(sql).all(stamp) as Array<{ id: string }>).map((r) => r.id);
      // Not a tautology: the reference itself must pick exactly the stuck ones.
      const expected = parked(PARKED_CHILDREN_NOT_IN_SQL).sort();
      expect(expected).toEqual(["par-backlog", "par-todo"]);
      expect(parked(PARKED_CHILDREN_CANDIDATES_SQL).sort()).toEqual(expected);

      expect((db.query(CHECKS_RUNNING_SQL).all() as Array<{ id: string }>).map((r) => r.id)).toEqual(["chk-running"]);
    } finally {
      db.exec("DELETE FROM tasks");
    }
  });
});
