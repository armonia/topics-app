/**
 * Planner statistics on `tasks` (`refreshPlannerStats`, server/db.ts).
 *
 * Without `sqlite_stat1` SQLite treats every index as equally selective and
 * reads the children of a card through `idx_tasks_archived`, i.e. almost the
 * whole table. With stats it takes `idx_tasks_parent`, but it also re-orders
 * joins: two call sites flipped to scanning every task and were pinned with
 * CROSS JOIN. Both halves are checked on the real schema (all migrations) and
 * on the SQL the real code runs, captured at `prepare`, not a copy of it.
 *
 * @covers PERF-02
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDatabase, closeDatabase, refreshPlannerStats } from "./db";
import { createTaskService } from "./services/tasks";
import { readDispatchBinding } from "./services/agent-job-quota";

let tmpRoot: string;
let db: Database;

/** The open-children count of `tasks.ts`, verbatim. */
const COUNT_OPEN_CHILDREN = "SELECT COUNT(*) AS c FROM tasks WHERE parent_task_id = ? AND archived = 0 AND status != 'done'";

const plan = (sql: string): string[] =>
  (db.query(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((r) => r.detail);

/** Runs `fn` and returns every SQL string it prepared that matches `re`. */
function captureSql(re: RegExp, fn: () => void): string[] {
  const seen: string[] = [];
  const origPrepare = db.prepare.bind(db);
  const origQuery = db.query.bind(db);
  (db as any).prepare = (sql: string) => { if (re.test(sql)) seen.push(sql); return origPrepare(sql); };
  (db as any).query = (sql: string) => { if (re.test(sql)) seen.push(sql); return origQuery(sql); };
  try { fn(); } finally { (db as any).prepare = origPrepare; (db as any).query = origQuery; }
  return seen;
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "planner-stats-test-"));
  const migDir = join(tmpRoot, "server", "db", "migrations");
  mkdirSync(migDir, { recursive: true });
  const realMigDir = join(import.meta.dir, "db", "migrations");
  for (const f of readdirSync(realMigDir)) {
    if (f.endsWith(".sql")) writeFileSync(join(migDir, f), readFileSync(join(realMigDir, f), "utf-8"));
  }
  db = initDatabase(tmpRoot);

  // The live shape: thousands of non-archived done cards, a few open ones with
  // a parent chain, and a few hundred attempts.
  const ts = "2026-09-30T10:00:00.000Z";
  const insertTask = db.prepare(
    "INSERT INTO tasks (id, project_id, text, status, archived, parent_task_id, created_at, updated_at) VALUES (?, 'p', ?, ?, 0, ?, ?, ?)",
  );
  db.transaction(() => {
    for (let i = 0; i < 3000; i++) insertTask.run(`done-${i}`, `card ${i}`, "done", null, ts, ts);
    insertTask.run("root", "root", "in_progress", null, ts, ts);
    insertTask.run("mid", "mid", "in_progress", "root", ts, ts);
    insertTask.run("leaf", "leaf", "in_progress", "mid", ts, ts);
    const insertAttempt = db.prepare("INSERT INTO task_attempts (id, task_id, idx, topic_id, created_at) VALUES (?, ?, 1, ?, ?)");
    for (let i = 0; i < 400; i++) insertAttempt.run(`att-${i}`, `done-${i}`, `topic-${i}`, ts);
  })();
});

afterAll(() => {
  try { closeDatabase(); } catch { /* already closed */ }
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("refreshPlannerStats", () => {
  test("without stats the children of a card are read through idx_tasks_archived", () => {
    expect(plan(COUNT_OPEN_CHILDREN).join(" / ")).toContain("idx_tasks_archived");
  });

  test("after ANALYZE tasks they are read through idx_tasks_parent, and only tasks has stats", () => {
    refreshPlannerStats(db);
    expect(plan(COUNT_OPEN_CHILDREN).join(" / ")).toContain("idx_tasks_parent");
    const tables = (db.query("SELECT DISTINCT tbl FROM sqlite_stat1").all() as { tbl: string }[]).map((r) => r.tbl);
    expect(tables).toEqual(["tasks"]);
  });

  test("with stats the ancestor chain of a subtask stays the outer loop", () => {
    refreshPlannerStats(db);
    const svc = createTaskService(db, { fileExists: () => false });
    const [sql] = captureSql(/WITH RECURSIVE chain/, () => { svc.get("leaf"); });
    expect(sql).toBeDefined();
    // `SCAN t` would be every task probed against the chain.
    expect(plan(sql!)).not.toContain("SCAN t");
  });

  test("with stats the fan-out binding scans task_attempts, not tasks", () => {
    refreshPlannerStats(db);
    db.run("INSERT INTO topics (id, slug, name, session_key, created_at, updated_at) VALUES ('t-nobody', 'nobody', 'x', 'topic:nobody', 0, 0)");
    const sqls = captureSql(/task_attempts a/, () => { readDispatchBinding(db, "topic:nobody"); });
    expect(sqls.length).toBeGreaterThan(0);
    for (const sql of sqls) expect(plan(sql)).not.toContain("SCAN k");
  });
});
