/**
 * `20260930195818-tasks-done-recency-index.sql`: the partial index that hands
 * the board feed its N most recent done cards already sorted.
 * @covers SCHEMA-07
 *
 * The file itself runs on the real schema (every migration before it), on the
 * SQL the task service really prepares, captured at `prepare`: an index the
 * planner does not pick has fixed nothing. Three things are checked:
 * - the feed's done-cap subquery stops sorting every done card in a temp
 *   B-tree, with and without the `ANALYZE tasks` stats (refreshPlannerStats);
 * - the feed returns the same rows, in the same order;
 * - no statement without the done-cap subquery changes plan. The
 *   unrestricted (archived, status, recency) index was taken by
 *   `status IN ('review', 'done')` and made two periodic passes twice as slow;
 *   the partial WHERE is what keeps them out. The project board's own done cap
 *   may take the index too, depending on the stats: on this synthetic board it
 *   does, on the live copy it did not.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PROJECT_ROOT } from "./helpers";
import { initDatabase, closeDatabase, refreshPlannerStats } from "../../server/db";
import { createTaskService } from "../../server/services/tasks";

const NAME = "20260930195818-tasks-done-recency-index.sql";
const MIGRATION_SQL = readFileSync(join(PROJECT_ROOT, "server/db/migrations", NAME), "utf-8");
const FEED = { scope: "all", rootsOnly: true, includeOrphanSubtasks: true, doneLimit: 120 } as const;

let tmpRoot: string | null = null;

afterEach(() => {
  try { closeDatabase(); } catch { /* already closed */ }
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = null;
});

/** The live shape on the real schema, without this migration: thousands of done cards, a few open ones. */
function dbBefore(): Database {
  tmpRoot = mkdtempSync(join(tmpdir(), "done-recency-index-"));
  const migDir = join(tmpRoot, "server", "db", "migrations");
  mkdirSync(migDir, { recursive: true });
  const realMigDir = join(PROJECT_ROOT, "server", "db", "migrations");
  for (const f of readdirSync(realMigDir)) {
    if (f.endsWith(".sql") && f !== NAME) writeFileSync(join(migDir, f), readFileSync(join(realMigDir, f), "utf-8"));
  }
  const db = initDatabase(tmpRoot);
  const insert = db.prepare(
    `INSERT INTO tasks (id, project_id, text, status, archived, parent_task_id, created_at, updated_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const at = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 3_600_000).toISOString();
  db.transaction(() => {
    for (let i = 0; i < 3000; i++) {
      // Some done cards have no completed_at: the order falls back to updated_at.
      insert.run(`done-${i}`, i % 3 ? "p" : "q", `card ${i}`, "done", 0, null, at(i), at((i * 7919) % 3000), i % 5 ? at((i * 104729) % 3000) : null);
    }
    for (let i = 0; i < 60; i++) insert.run(`arch-${i}`, "p", `old ${i}`, "done", 1, null, at(i), at(4000 + i), at(4000 + i));
    insert.run("open", "p", "open", "in_progress", 0, null, at(1), at(5000), null);
    insert.run("step", "p", "step", "todo", 0, "done-1", at(1), at(5001), null);
    insert.run("rev", "p", "rev", "review", 0, null, at(1), at(5002), null);
  })();
  return db;
}

/** Every SQL string `fn` prepared on `db`. */
function captureSql(db: Database, fn: () => void): string[] {
  const seen: string[] = [];
  const origPrepare = db.prepare.bind(db);
  const origQuery = db.query.bind(db);
  (db as unknown as { prepare: (s: string) => unknown }).prepare = (sql: string) => { seen.push(sql); return origPrepare(sql); };
  (db as unknown as { query: (s: string) => unknown }).query = (sql: string) => { seen.push(sql); return origQuery(sql); };
  try { fn(); } finally {
    (db as unknown as { prepare: typeof origPrepare }).prepare = origPrepare;
    (db as unknown as { query: typeof origQuery }).query = origQuery;
  }
  return seen;
}

type PlanRow = { id: number; parent: number; detail: string };
const planRows = (db: Database, sql: string) => db.query(`EXPLAIN QUERY PLAN ${sql}`).all() as PlanRow[];
const planText = (db: Database, sql: string) => planRows(db, sql).map((r) => r.detail).join(" / ");

/** What the done-cap subquery of the feed does: the details of the rows under its LIST SUBQUERY. */
function doneCapPlan(db: Database, sql: string): string {
  const rows = planRows(db, sql);
  const list = rows.find((r) => r.detail.startsWith("LIST SUBQUERY"));
  expect(list).toBeDefined();
  return rows.filter((r) => r.parent === list!.id).map((r) => r.detail).join(" / ");
}

/** The SELECT the feed runs on `tasks`. */
function feedSql(db: Database): string {
  const svc = createTaskService(db, { fileExists: () => false });
  const [sql] = captureSql(db, () => { svc.list(FEED); }).filter((s) => /ORDER BY updated_at DESC/.test(s));
  expect(sql).toBeDefined();
  return sql!;
}

/** The statements several service calls prepare, the feed among them, deduplicated. */
function serviceStatements(db: Database): string[] {
  const svc = createTaskService(db, { fileExists: () => false });
  const sqls = captureSql(db, () => {
    svc.list(FEED);
    svc.list({ ...FEED, scope: "project", projectId: "p" });
    svc.list({ scope: "project", projectId: "p" });
    svc.list({ scope: "all" });
    svc.list({ scope: "all", archived: true, rootsOnly: true });
    svc.list({ scope: "project", projectId: "p", status: "done" });
    svc.listLandingAuditCandidates();
    svc.get("done-1");
  });
  return [...new Set(sqls)].filter((s) => /^\s*(SELECT|WITH)/i.test(s));
}

describe("migration 20260930195818: idx_tasks_done_recency", () => {
  test("before it, the feed sorts every done card to keep the most recent 120", () => {
    const db = dbBefore();
    const sql = feedSql(db);
    expect(doneCapPlan(db, sql)).toContain("USE TEMP B-TREE FOR ORDER BY");
    refreshPlannerStats(db);
    expect(doneCapPlan(db, sql)).toContain("USE TEMP B-TREE FOR ORDER BY");
  });

  test("after it, the planner reads the done cards in order from the index, with and without stats", () => {
    const db = dbBefore();
    db.run(MIGRATION_SQL);
    const sql = feedSql(db);
    for (const withStats of [false, true]) {
      if (withStats) refreshPlannerStats(db);
      const sub = doneCapPlan(db, sql);
      expect(sub).toContain("idx_tasks_done_recency");
      expect(sub).not.toContain("USE TEMP B-TREE FOR ORDER BY");
    }
  });

  test("the feed returns the same rows in the same order", () => {
    const db = dbBefore();
    const svc = createTaskService(db, { fileExists: () => false });
    const ids = () => svc.list(FEED).map((t) => t.id);
    const before = ids();
    db.run(MIGRATION_SQL);
    refreshPlannerStats(db);
    expect(ids()).toEqual(before);
    // 120 done cards, the two open roots, and the open step whose parent is done.
    expect(before.length).toBe(120 + 3);
    expect(before).toEqual(expect.arrayContaining(["open", "rev", "step"]));
  });

  test("only the done-cap feeds change plan: the partial WHERE keeps status IN (...) off the index", () => {
    const db = dbBefore();
    refreshPlannerStats(db);
    const statements = serviceStatements(db);
    const feed = feedSql(db);
    expect(statements.some((s) => /status IN \('review', 'done'\)/.test(s))).toBe(true);
    const before = new Map(statements.map((s) => [s, planText(db, s)]));
    db.run(MIGRATION_SQL);
    refreshPlannerStats(db);
    const changed = statements.filter((s) => planText(db, s) !== before.get(s));
    expect(changed).toContain(feed);
    for (const s of changed) expect(s).toMatch(/status = 'done'(\s+AND project_id = \?)?\s+ORDER BY COALESCE\(completed_at, updated_at\) DESC LIMIT \?/);
    for (const s of statements.filter((x) => /status IN \(/.test(x))) expect(planText(db, s)).toBe(before.get(s)!);
  });

  test("running it twice changes nothing", () => {
    const db = dbBefore();
    db.run(MIGRATION_SQL);
    db.run(MIGRATION_SQL);
    const idx = db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_tasks_done_recency'").all();
    expect(idx).toHaveLength(1);
  });
});
