/**
 * `20261002192446-command-runs-last-output.sql`: the time a run from the chat
 * last printed, kept on its row so that it survives the boot that deletes the
 * run's log.
 * @covers CMDRUN-06
 *
 * The file itself, on the real schema (every migration before it): the column
 * is not there before and is after, empty; the rows written before it keep
 * every value they had; a running run can write it and a closed one keeps it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PROJECT_ROOT } from "./helpers";
import { initDatabase, closeDatabase } from "../../server/db";

const NAME = "20261002192446-command-runs-last-output.sql";
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

/** A database with every migration before this one, and two runs written then: one running, one closed. */
function dbBefore(): Database {
  // The DB is a process singleton: a handle left open by an earlier file in
  // the same run would be handed back instead of this fresh schema.
  closeDatabase();
  savedDataDir = process.env.DATA_DIR;
  delete process.env.DATA_DIR;
  tmpRoot = mkdtempSync(join(tmpdir(), "command-runs-last-output-migration-"));
  const migDir = join(tmpRoot, "server", "db", "migrations");
  mkdirSync(migDir, { recursive: true });
  const realMigDir = join(PROJECT_ROOT, "server", "db", "migrations");
  for (const f of readdirSync(realMigDir)) {
    // Only the ones before it: the rows below are written on the schema it alters.
    if (f.endsWith(".sql") && parseInt(f, 10) < parseInt(NAME, 10)) writeFileSync(join(migDir, f), readFileSync(join(realMigDir, f), "utf-8"));
  }
  const db = initDatabase(tmpRoot);
  db.run("INSERT INTO messages (id, session_key, role, content, timestamp, sort_order) VALUES ('m-1', 's', 'assistant', '```bash\nls\n```', '2026-10-01', 0)");
  const insert = db.prepare(
    `INSERT INTO command_runs (id, session_key, message_id, block_key, command, cwd, status, exit_code, started_at, ended_at, output, dropped_lines)
     VALUES (?, 's', 'm-1', ?, 'ls', '/tmp', ?, ?, ?, ?, ?, ?)`,
  );
  insert.run("r-running", 0, "running", null, "2026-10-01T10:00:00.000Z", null, null, 0);
  insert.run("r-done", 1, "done", 0, "2026-10-01T09:00:00.000Z", "2026-10-01T09:00:05.000Z", "a\nb", 3);
  return db;
}

const columns = (db: Database) => (db.query("PRAGMA table_info(command_runs)").all() as Array<{ name: string; type: string; notnull: number; dflt_value: unknown }>);
// `prepare`, not `query`: a cached `SELECT *` keeps the columns it was compiled with.
const rows = (db: Database) => db.prepare("SELECT * FROM command_runs ORDER BY id").all();

describe("migration 20261002192446: command_runs.last_output_at", () => {
  test("before it the column does not exist", () => {
    const db = dbBefore();
    expect(columns(db).map((c) => c.name)).not.toContain("last_output_at");
  });

  test("after it the column is there, nullable text with no default, and empty on the rows written before", () => {
    const db = dbBefore();
    const before = rows(db) as Array<Record<string, unknown>>;
    db.run(MIGRATION_SQL);
    expect(columns(db).find((c) => c.name === "last_output_at")).toMatchObject({ type: "TEXT", notnull: 0, dflt_value: null });
    // Every value the old rows had is still there, and the new column is empty on them.
    expect(rows(db)).toEqual(before.map((r) => ({ ...r, last_output_at: null })));
  });

  test("a running run writes it, and closing the run keeps it", () => {
    const db = dbBefore();
    db.run(MIGRATION_SQL);
    db.run("UPDATE command_runs SET last_output_at = '2026-10-01T10:00:07.000Z' WHERE id = 'r-running'");
    db.run("UPDATE command_runs SET status = 'unknown', ended_at = last_output_at WHERE id = 'r-running'");
    expect(db.query("SELECT status, ended_at, last_output_at FROM command_runs WHERE id = 'r-running'").get())
      .toEqual({ status: "unknown", ended_at: "2026-10-01T10:00:07.000Z", last_output_at: "2026-10-01T10:00:07.000Z" });
  });
});
