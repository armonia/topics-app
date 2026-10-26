/**
 * Applies the reservation migration through the real runner to synthetic DBs.
 * @covers SCHEMA-07
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeDatabase, initDatabase } from "../../server/db";
import { cleanupTestDataDir, setupTestDataDir, testTmpDir } from "./helpers";

const ROOT = testTmpDir("migration-no-local-check-reservations");
const LIVE_MIGRATION = readFileSync(join(import.meta.dir, "../../server/db/migrations/20261025210852-task-no-local-check-reservations.sql"), "utf8");
const FIXTURE = `
CREATE TABLE tasks (id TEXT PRIMARY KEY);
CREATE TABLE task_attempts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  UNIQUE (task_id, idx)
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_key TEXT NOT NULL,
  parent_id TEXT,
  sort_order INTEGER NOT NULL
);
`;
const LEGACY_MIGRATION = `ALTER TABLE task_attempts ADD COLUMN no_local_checks_reservation_gb REAL;`;

beforeAll(() => setupTestDataDir(join(ROOT, "data")));
afterAll(async () => cleanupTestDataDir(ROOT));

function writeMigration(baseDir: string, name: string, sql: string): void {
  const dir = join(baseDir, "server", "db", "migrations");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), sql);
}

function boot(baseDir: string, dataDir: string) {
  closeDatabase();
  process.env.DATA_DIR = dataDir;
  return initDatabase(baseDir, dataDir);
}

const names = (db: ReturnType<typeof initDatabase>) =>
  (db.query<{ name: string }, []>("SELECT name FROM schema_migrations ORDER BY version").all()).map((row) => row.name);

describe("migration task no-local-check reservation", () => {
  test("fresh synthetic DB and second boot apply it once", () => {
    const baseDir = join(ROOT, "fresh-bundle");
    const dataDir = join(ROOT, "fresh-data");
    writeMigration(baseDir, "20261025000000-task-attempt-fixture.sql", FIXTURE);
    writeMigration(baseDir, "20261025210852-task-no-local-check-reservations.sql", LIVE_MIGRATION);

    let db = boot(baseDir, dataDir);
    expect(db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name='task_no_local_check_reservations'").get()?.name)
      .toBe("task_no_local_check_reservations");
    expect(names(db)).toEqual([
      "20261025000000-task-attempt-fixture.sql",
      "20261025210852-task-no-local-check-reservations.sql",
    ]);
    expect(() => db.exec(LIVE_MIGRATION)).not.toThrow();
    closeDatabase();

    db = boot(baseDir, dataDir);
    expect(names(db)).toHaveLength(2);
    closeDatabase();
  });

  test("a DB with the #449 filename already applied gets the unique migration", () => {
    const baseDir = join(ROOT, "legacy-bundle");
    const dataDir = join(ROOT, "legacy-data");
    writeMigration(baseDir, "20261025000000-task-attempt-fixture.sql", FIXTURE);
    writeMigration(baseDir, "20261025110000-task-attempt-no-local-checks-reservation.sql", LEGACY_MIGRATION);

    let db = boot(baseDir, dataDir);
    expect(db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('task_attempts') WHERE name='no_local_checks_reservation_gb'").get()?.name)
      .toBe("no_local_checks_reservation_gb");
    closeDatabase();

    writeMigration(baseDir, "20261025210852-task-no-local-check-reservations.sql", LIVE_MIGRATION);
    db = boot(baseDir, dataDir);
    expect(db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name='task_no_local_check_reservations'").get()?.name)
      .toBe("task_no_local_check_reservations");
    expect(names(db)).toEqual([
      "20261025000000-task-attempt-fixture.sql",
      "20261025110000-task-attempt-no-local-checks-reservation.sql",
      "20261025210852-task-no-local-check-reservations.sql",
    ]);
    closeDatabase();

    db = boot(baseDir, dataDir);
    expect(names(db)).toHaveLength(3);
    closeDatabase();
  });
});
