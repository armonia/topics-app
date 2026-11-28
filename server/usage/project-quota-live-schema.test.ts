/**
 * The project_quota table is live since 20261119000000. A later migration adds
 * `limit_none`; the runner skips files already applied, so the column can only
 * reach a live database through its own, additive migration. This starts from
 * the table exactly as the first migration created it, with that file marked
 * as applied, then applies the migrations that came after.
 * @covers USAGE-29
 */
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readProjectLimits, setProjectLimit } from "./project-limit";
import { readProjectQuotaRow } from "../services/project-pause";

const DIR = join(import.meta.dir, "../db/migrations");
const FIRST = "20261119000000-project-quota.sql";

/** The live table: six columns, no `limit_none`. */
const LIVE_TABLE = `CREATE TABLE project_quota (
  project_id TEXT PRIMARY KEY,
  limit_24h_pct REAL,
  paused_at TEXT,
  continued_until_pct REAL,
  hold_until INTEGER,
  updated_at TEXT NOT NULL
)`;

function liveDb(): Database {
  const db = new Database(":memory:");
  db.exec(LIVE_TABLE);
  db.run("INSERT INTO project_quota (project_id, limit_24h_pct, updated_at) VALUES ('old', 10, 'x')");
  // Every later migration that touches the table, in order; the first one is already applied.
  const later = readdirSync(DIR)
    .filter((f) => f.endsWith(".sql") && f > FIRST && readFileSync(join(DIR, f), "utf8").includes("project_quota"))
    .sort();
  for (const f of later) db.exec(readFileSync(join(DIR, f), "utf8"));
  return db;
}

test("the live table gains limit_none and the readers and writers work on it", () => {
  const db = liveDb();
  const cols = (db.query("PRAGMA table_info(project_quota)").all() as { name: string }[]).map((c) => c.name);
  expect(cols).toContain("limit_none");

  expect(readProjectQuotaRow(db, "old")?.limit24hPct).toBe(10);
  expect(readProjectLimits(db).get("old")).toBe(10);

  setProjectLimit(db, "fresh", 20);
  expect(readProjectLimits(db).get("fresh")).toBe(20);
  setProjectLimit(db, "fresh", null);
  expect(readProjectLimits(db).get("fresh")).toBeNull();
});
