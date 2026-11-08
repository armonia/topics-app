/**
 * The status bar and the Discord presence read the working cards through
 * WORKING_TASKS_COUNT_SQL and OLDEST_WORKING_BOARD_SQL. Archiving a working card
 * sets `archived = 1` and leaves `dispatch_state = 'working'`: these reads must
 * not count it, nor name its board.
 *
 * @covers DISCORD-01
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, initDatabase } from "../db";
import { OLDEST_WORKING_BOARD_SQL, WORKING_TASKS_COUNT_SQL } from "./task-timer-reads";

let tmpRoot: string;
let db: Database;

const insertTask = (id: string, projectId: string, archived: number, inProgressAt: string) =>
  db.run(
    `INSERT INTO tasks (id, project_id, text, status, archived, dispatch_state, in_progress_at, created_at, updated_at)
     VALUES (?, ?, 'x', 'in_progress', ?, 'working', ?, ?, ?)`,
    [id, projectId, archived, inProgressAt, inProgressAt, inProgressAt],
  );

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "task-timer-reads-test-"));
  const migDir = join(tmpRoot, "server", "db", "migrations");
  mkdirSync(migDir, { recursive: true });
  const realMigDir = join(import.meta.dir, "..", "db", "migrations");
  for (const f of readdirSync(realMigDir)) {
    if (f.endsWith(".sql")) writeFileSync(join(migDir, f), readFileSync(join(realMigDir, f), "utf-8"));
  }
  db = initDatabase(tmpRoot);
});

afterAll(() => {
  try { closeDatabase(); } catch { /* already closed */ }
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("working cards for the status bar and the presence", () => {
  test("an archived working card is not counted and names no board", () => {
    insertTask("archived-working", "p-archived", 1, "2026-01-01T00:00:00.000Z");
    expect(db.query(WORKING_TASKS_COUNT_SQL).get()).toEqual({ v: 0 });
    expect(db.query(OLDEST_WORKING_BOARD_SQL).get()).toBeNull();
  });

  test("a live working card is still counted, even if an archived one is older", () => {
    insertTask("live-working", "p-live", 0, "2026-02-01T00:00:00.000Z");
    expect(db.query(WORKING_TASKS_COUNT_SQL).get()).toEqual({ v: 1 });
    expect(db.query(OLDEST_WORKING_BOARD_SQL).get()).toEqual({ v: "p-live" });
  });
});
