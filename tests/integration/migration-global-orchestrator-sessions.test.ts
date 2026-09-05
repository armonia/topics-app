/**
 * The registry table arrives on a database that is already full:
 * `20260904110000-global-orchestrator-sessions.sql`.
 *
 * It is additive (`CREATE TABLE IF NOT EXISTS`), which is exactly the kind of
 * migration nobody tests and then runs against a live file. What is worth
 * proving is not that it creates a table, it is what it does NOT do: an
 * existing database keeps its rows, a second run is a no-op, and the
 * constraints the whole role rests on are really in the schema rather than
 * only in the code that reads it. The registry row is the ONLY identity of the
 * coordinator, so `scope = 'global'`, the uniqueness of `topic_id`, and the
 * cascade from `topics` are load-bearing.
 *
 * The test executes the migration FILE, not a copy: if the DDL changes, it
 * changes underneath these cases.
 * @covers GLOBAL-ORCHESTRATOR-REGISTRY-01
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import path from "node:path";
import { setupTestDataDir, createTestAppContext, PROJECT_ROOT, testTmpDir } from "./helpers";
import { EMBEDDED_MIGRATIONS } from "../../server/db/migrations-embedded";

const TEST_DATA = testTmpDir("migration-global-orchestrator-data");
const MIGRATION_NAME = "20260904110000-global-orchestrator-sessions.sql";
const MIGRATION_VERSION = 20260904110000;

const MIGRATION_SQL = fs.readFileSync(
  path.join(PROJECT_ROOT, "server/db/migrations", MIGRATION_NAME),
  "utf-8",
);

beforeAll(() => setupTestDataDir(TEST_DATA));

/**
 * A synthetic database with just enough of the real schema to hold the foreign
 * key: `topics` is the only table this migration references, and building it by
 * hand keeps the test about the DDL instead of about the 145 migrations that
 * come before it.
 */
function syntheticDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE topics (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      session_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    )
  `);
  db.prepare("INSERT INTO topics (id, name, session_key, created_at) VALUES (?, ?, ?, ?)")
    .run("t-coordinator", "Kanban coordinator", "topic:coordinator", "2026-09-04T00:00:00.000Z");
  db.prepare("INSERT INTO topics (id, name, session_key, created_at) VALUES (?, ?, ?, ?)")
    .run("t-ordinary", "An ordinary chat", "topic:ordinary", "2026-09-04T00:00:00.000Z");
  return db;
}

function register(db: Database, topicId: string, scope = "global"): void {
  db.prepare(
    `INSERT INTO global_orchestrator_sessions (scope, topic_id, created_at, updated_at)
     VALUES (?, ?, '2026-09-04T00:00:00.000Z', '2026-09-04T00:00:00.000Z')`,
  ).run(scope, topicId);
}

describe("migration 20260904110000 - the coordinator's registry table", () => {
  test("creates the table on a database that already holds data, and touches nothing else", () => {
    const db = syntheticDb();
    db.exec(MIGRATION_SQL);

    const topics = db.query("SELECT id FROM topics ORDER BY id").all() as Array<{ id: string }>;
    expect(topics.map((row) => row.id)).toEqual(["t-coordinator", "t-ordinary"]);
    const rows = db.query("SELECT COUNT(*) n FROM global_orchestrator_sessions").get() as { n: number };
    expect(rows.n).toBe(0);
    db.close();
  });

  test("a second run is a no-op and keeps the row already registered", () => {
    const db = syntheticDb();
    db.exec(MIGRATION_SQL);
    register(db, "t-coordinator");

    db.exec(MIGRATION_SQL);

    const row = db.query("SELECT topic_id FROM global_orchestrator_sessions").get() as { topic_id: string };
    expect(row.topic_id).toBe("t-coordinator");
    db.close();
  });

  test("one coordinator at a time: the scope is the primary key and only 'global' passes", () => {
    const db = syntheticDb();
    db.exec(MIGRATION_SQL);
    register(db, "t-coordinator");

    // A second global row would be a second privileged identity.
    expect(() => register(db, "t-ordinary")).toThrow();
    // And a made-up scope is not a way around the primary key.
    expect(() => register(db, "t-ordinary", "also-global")).toThrow();
    db.close();
  });

  test("the same Topic cannot be registered twice under a different row", () => {
    const db = syntheticDb();
    db.exec(MIGRATION_SQL);
    register(db, "t-coordinator");
    db.exec("DELETE FROM global_orchestrator_sessions");
    register(db, "t-coordinator");

    const rows = db.query("SELECT COUNT(*) n FROM global_orchestrator_sessions").get() as { n: number };
    expect(rows.n).toBe(1);
    db.close();
  });

  test("deleting the Topic deletes the role: the registry cannot outlive its row", () => {
    const db = syntheticDb();
    db.exec(MIGRATION_SQL);
    register(db, "t-coordinator");

    db.prepare("DELETE FROM topics WHERE id = ?").run("t-coordinator");

    const rows = db.query("SELECT COUNT(*) n FROM global_orchestrator_sessions").get() as { n: number };
    expect(rows.n).toBe(0);
    db.close();
  });

  test("a Topic that does not exist cannot be registered", () => {
    const db = syntheticDb();
    db.exec(MIGRATION_SQL);

    expect(() => register(db, "t-does-not-exist")).toThrow();
    db.close();
  });

  test("it is in the embedded manifest, in version order: that is the copy that actually runs", async () => {
    // The manifest is generated (`scripts/gen-migrations-manifest.ts`) and the
    // runner walks it in array order. A merge appended this entry at the end,
    // after two later timestamps, which is the one way an additive migration
    // can still land in the wrong place.
    const index = EMBEDDED_MIGRATIONS.findIndex((migration) => migration.name === MIGRATION_NAME);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(EMBEDDED_MIGRATIONS[index]!.version).toBe(MIGRATION_VERSION);
    const versions = EMBEDDED_MIGRATIONS.map((migration) => migration.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));

    // And the table is really there after the ordinary boot path, not only
    // after executing the file by hand.
    const ctx = await createTestAppContext();
    const table = ctx.db.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'global_orchestrator_sessions'",
    ).get() as { name: string } | null;
    expect(table?.name).toBe("global_orchestrator_sessions");
  });
});
