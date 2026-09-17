/**
 * THE CHECKS MEMORY FLOOR AS IT IS WRITTEN, from the reserved '*' settings row.
 *
 * Its own file and not a describe inside `dispatch-capacity.test.ts`, which was
 * already within a few lines of the `check:bloat` threshold: this reader answers
 * a different question from the ones there (what a check command needs, not what
 * the machine can admit) and it is the one that landed with the floor becoming a
 * setting.
 *
 * @covers KANBAN-15
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readChecksMemFloorGB } from "./dispatch-capacity";
import { CHECKS_MEM_FLOOR_DEFAULT_GB, CHECKS_MEM_FLOOR_MAX_GB } from "../../shared/checks-memory-floor";

/** The two columns every reader of this row assumes, and nothing else: a harness
 *  that is missing the floor column is one of the cases under test. */
function settingsDb(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE board_settings (project_id TEXT PRIMARY KEY, max_agents INTEGER, max_agents_auto INTEGER)`);
  return db;
}

/**
 * THE CHECKS FLOOR AS IT IS WRITTEN, from the same reserved row. The reader has
 * one job the concurrency cap's does not: it must tell "nobody has ever set
 * this" apart from "the owner switched the brake off", because those are the
 * same column and opposite answers.
 */
describe("readChecksMemFloorGB — the checks floor as it is written", () => {
  const dbWithFloor = (): Database => {
    const db = settingsDb();
    db.run(`ALTER TABLE board_settings ADD COLUMN checks_mem_floor_gb REAL`);
    return db;
  };

  test("no row at all, and a db without the column, both read as the default", () => {
    // A minimal harness or an install older than the migration must behave like
    // a fresh one. Reading a missing column as 0 would switch the brake off on
    // nobody's authority, and the round would never wait again.
    expect(readChecksMemFloorGB(dbWithFloor())).toBe(CHECKS_MEM_FLOOR_DEFAULT_GB);
    expect(readChecksMemFloorGB(settingsDb())).toBe(CHECKS_MEM_FLOOR_DEFAULT_GB);
  });

  test("NULL is 'never set' and reads as the default, 0 is 'off' and survives", () => {
    const db = dbWithFloor();
    db.run(`INSERT INTO board_settings (project_id, max_agents, checks_mem_floor_gb) VALUES ('*', 3, NULL)`);
    expect(readChecksMemFloorGB(db)).toBe(CHECKS_MEM_FLOOR_DEFAULT_GB);
    db.run(`UPDATE board_settings SET checks_mem_floor_gb = 0 WHERE project_id = '*'`);
    expect(readChecksMemFloorGB(db)).toBe(0);
  });

  test("a written value comes back, and one written out of range comes back clamped", () => {
    const db = dbWithFloor();
    db.run(`INSERT INTO board_settings (project_id, max_agents, checks_mem_floor_gb) VALUES ('*', 3, 8)`);
    expect(readChecksMemFloorGB(db)).toBe(8);
    // Clamped on read as well as on write: a row edited by hand must not be able
    // to produce a floor no machine can ever clear.
    db.run(`UPDATE board_settings SET checks_mem_floor_gb = 999 WHERE project_id = '*'`);
    expect(readChecksMemFloorGB(db)).toBe(CHECKS_MEM_FLOOR_MAX_GB);
    db.run(`UPDATE board_settings SET checks_mem_floor_gb = -4 WHERE project_id = '*'`);
    expect(readChecksMemFloorGB(db)).toBe(0);
  });
});
