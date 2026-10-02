/**
 * `20261001220421-command-runs.sql`: the table a run of a command from the
 * chat lives in, beside the message whose block it ran.
 * @covers CMDRUN-06
 *
 * The file itself, on the real schema (every migration before it): the table
 * appears empty, running it twice changes nothing, a run dies with its message
 * (the foreign key the server turns on), the device that launched it may go
 * without taking the run along, and the last run of a block is read from the
 * index, not from a scan.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PROJECT_ROOT } from "./helpers";
import { initDatabase, closeDatabase } from "../../server/db";

const NAME = "20261001220421-command-runs.sql";
const MIGRATION_SQL = readFileSync(join(PROJECT_ROOT, "server/db/migrations", NAME), "utf-8");

let tmpRoot: string | null = null;
let savedDataDir: string | undefined;
afterEach(() => {
  try { closeDatabase(); } catch { /* already closed */ }
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = null;
  if (savedDataDir !== undefined) process.env.DATA_DIR = savedDataDir;
  savedDataDir = undefined;
});

function dbBefore(): Database {
  // The DB is a process singleton: a handle left open by an earlier file in
  // the same run would be handed back instead of this fresh schema.
  closeDatabase();
  savedDataDir = process.env.DATA_DIR;
  delete process.env.DATA_DIR;
  tmpRoot = mkdtempSync(join(tmpdir(), "command-runs-migration-"));
  const migDir = join(tmpRoot, "server", "db", "migrations");
  mkdirSync(migDir, { recursive: true });
  const realMigDir = join(PROJECT_ROOT, "server", "db", "migrations");
  for (const f of readdirSync(realMigDir)) {
    if (f.endsWith(".sql") && f !== NAME) writeFileSync(join(migDir, f), readFileSync(join(realMigDir, f), "utf-8"));
  }
  const db = initDatabase(tmpRoot);
  const insert = db.prepare("INSERT INTO messages (id, session_key, role, content, timestamp, sort_order) VALUES (?, 's', 'assistant', '```bash\nls\n```', '2026-10-01', ?)");
  insert.run("m-1", 0);
  insert.run("m-2", 1);
  db.run("INSERT INTO devices (id, name, token_hash, created_at) VALUES ('d-1', 'phone', 'h', 0)");
  return db;
}

const insertRun = (db: Database, id: string, messageId: string, blockKey: number, startedAt: string, device: string | null = null) =>
  db.prepare(
    `INSERT INTO command_runs (id, session_key, message_id, block_key, command, cwd, status, started_at, author_device_id)
     VALUES (?, 's', ?, ?, 'ls', '/tmp', 'running', ?, ?)`,
  ).run(id, messageId, blockKey, startedAt, device);
const ids = (db: Database) => (db.query("SELECT id FROM command_runs ORDER BY id").all() as Array<{ id: string }>).map((r) => r.id);

describe("migration 20261001220421: command_runs", () => {
  test("before it the table does not exist", () => {
    const db = dbBefore();
    expect(() => db.query("SELECT * FROM command_runs").all()).toThrow();
  });

  test("after it the table is empty, with the defaults a fresh run reads; twice changes nothing", () => {
    const db = dbBefore();
    db.run(MIGRATION_SQL);
    expect(ids(db)).toEqual([]);
    insertRun(db, "r-1", "m-1", 0, "2026-10-01T10:00:00Z");
    db.run(MIGRATION_SQL);
    expect(db.query("SELECT id, status, exit_code, ended_at, output, dropped_lines FROM command_runs").all())
      .toEqual([{ id: "r-1", status: "running", exit_code: null, ended_at: null, output: null, dropped_lines: 0 }]);
  });

  test("a run goes with its message, and only with its message", () => {
    const db = dbBefore();
    db.run(MIGRATION_SQL);
    insertRun(db, "r-1", "m-1", 0, "2026-10-01T10:00:00Z");
    insertRun(db, "r-2", "m-1", 12, "2026-10-01T10:01:00Z");
    insertRun(db, "r-3", "m-2", 0, "2026-10-01T10:02:00Z");
    db.run("DELETE FROM messages WHERE id = 'm-1'");
    expect(ids(db)).toEqual(["r-3"]);
  });

  test("a run of a message that does not exist is refused", () => {
    const db = dbBefore();
    db.run(MIGRATION_SQL);
    expect(() => insertRun(db, "r-x", "nope", 0, "2026-10-01T10:00:00Z")).toThrow();
  });

  test("the device that launched a run may be deleted: the run stays, without an author", () => {
    const db = dbBefore();
    db.run(MIGRATION_SQL);
    insertRun(db, "r-1", "m-1", 0, "2026-10-01T10:00:00Z", "d-1");
    db.run("DELETE FROM devices WHERE id = 'd-1'");
    expect(db.query("SELECT id, author_device_id FROM command_runs").all()).toEqual([{ id: "r-1", author_device_id: null }]);
  });

  test("the last run of each block of a message is read through the index", () => {
    const db = dbBefore();
    db.run(MIGRATION_SQL);
    const plan = (db.query("EXPLAIN QUERY PLAN SELECT * FROM command_runs WHERE message_id = ? ORDER BY block_key, started_at DESC").all("m-1") as Array<{ detail: string }>)
      .map((r) => r.detail).join(" | ");
    expect(plan).toContain("idx_command_runs_message");
    expect(plan).not.toMatch(/SCAN command_runs(?! USING)/);
  });
});
