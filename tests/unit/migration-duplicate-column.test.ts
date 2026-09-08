/**
 * An existing column does not prove that a migration is complete: rollback
 * can undo other columns and leave indexes missing. Exercise the real runner
 * with migration 012 without rewriting its SQL.
 * @covers SCHEMA-05
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { closeDatabase, getDatabase, initDatabase } from "../../server/db";

const MIGRATION = "012-ui-state-payload-version.sql";
const SOURCE = resolve(import.meta.dir, "../../server/db/migrations", MIGRATION);
let fixtureRoot: string | undefined;
let previousDataDir: string | undefined;

beforeEach(() => {
  closeDatabase();
  previousDataDir = process.env.DATA_DIR;
});

afterEach(() => {
  closeDatabase();
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = undefined;
});

function fixture(extraColumns: string): { baseDir: string; dbPath: string } {
  const baseDir = mkdtempSync(join(tmpdir(), "migration-duplicate-column-"));
  fixtureRoot = baseDir;
  const migrationsDir = join(baseDir, "server", "db", "migrations");
  const dataDir = join(baseDir, "data");
  mkdirSync(migrationsDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  copyFileSync(SOURCE, join(migrationsDir, MIGRATION));
  process.env.DATA_DIR = dataDir;

  const dbPath = join(dataDir, "topics.db");
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE messages (id TEXT, session_key TEXT, sort_order INTEGER, parent_id TEXT);
      CREATE TABLE ui_state (key TEXT PRIMARY KEY, payload TEXT${extraColumns ? `, ${extraColumns}` : ""});
      INSERT INTO ui_state (key, payload) VALUES ('layout', '{"sidebar":true}');
    `);
  } finally {
    db.close();
  }
  return { baseDir, dbPath };
}

function snapshot(db: Database) {
  return {
    columns: db.query("PRAGMA table_info(ui_state)").all(),
    schema: db.query("SELECT type, name, sql FROM sqlite_master WHERE tbl_name = 'ui_state' ORDER BY name").all(),
    rows: db.query("SELECT * FROM ui_state ORDER BY key").all(),
  };
}

describe("migrations with existing columns", () => {
  test.each([
    ["payload_version only", "payload_version INTEGER NOT NULL DEFAULT 1"],
    ["server_seq only", "server_seq INTEGER NOT NULL DEFAULT 0"],
    ["both columns without the index", "payload_version INTEGER NOT NULL DEFAULT 1, server_seq INTEGER NOT NULL DEFAULT 0"],
  ])("stops without recording success: %s", (_name, extraColumns) => {
    const { baseDir, dbPath } = fixture(extraColumns);
    const before = new Database(dbPath);
    const initial = snapshot(before);
    before.close();

    let failure: unknown;
    let retryFailure: unknown;
    let accessFailure: unknown;
    try {
      initDatabase(baseDir);
    } catch (error) {
      failure = error;
    }
    try {
      getDatabase();
    } catch (error) {
      accessFailure = error;
    }
    try {
      initDatabase(baseDir);
    } catch (error) {
      retryFailure = error;
    } finally {
      closeDatabase();
    }

    const after = new Database(dbPath);
    try {
      expect(snapshot(after)).toEqual(initial);
      expect(after.query("SELECT name FROM schema_migrations WHERE version = 12").all()).toEqual([]);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("duplicate column name");
      expect(accessFailure).toBeInstanceOf(Error);
      expect((accessFailure as Error).message).toContain("Database not initialized");
      expect(retryFailure).toBeInstanceOf(Error);
      expect((retryFailure as Error).message).toContain("duplicate column name");
    } finally {
      after.close();
    }
  });

  test("applies all of migration 012 to the previous schema and skips it on restart", () => {
    const { baseDir } = fixture("");
    const db = initDatabase(baseDir);
    expect(db.query("SELECT payload_version, server_seq FROM ui_state WHERE key = 'layout'").get())
      .toEqual({ payload_version: 1, server_seq: 0 });
    expect(db.query("PRAGMA index_info(ui_state_server_seq_idx)").all())
      .toEqual([{ seqno: 0, cid: 3, name: "server_seq" }]);
    expect(db.query("SELECT name FROM schema_migrations WHERE version = 12").all())
      .toEqual([{ name: MIGRATION }]);
    const applied = snapshot(db);
    closeDatabase();

    const reopened = initDatabase(baseDir);
    expect(snapshot(reopened)).toEqual(applied);
    expect(reopened.query("SELECT name FROM schema_migrations WHERE version = 12").all())
      .toEqual([{ name: MIGRATION }]);
  });
});
