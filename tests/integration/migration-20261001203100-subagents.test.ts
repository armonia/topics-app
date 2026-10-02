/**
 * `20261001203100-subagents.sql`: the sub-agent rows that outlive their
 * terminal. The test runs the migration FILE against a synthetic database.
 * @covers SUBAGENT-14, SUBAGENT-15
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SQL = readFileSync(resolve(import.meta.dir, "../../server/db/migrations/20261001203100-subagents.sql"), "utf8");

function migrated(): Database {
  const db = new Database(":memory:");
  db.exec(SQL);
  return db;
}

describe("migration subagents", () => {
  test("a row born with only what a spawn knows starts running, nothing reported", () => {
    const db = migrated();
    db.run("INSERT INTO subagents (id, parent_session_key, name, cwd, created_at) VALUES ('c1', 'topic:t', 'scout', '/p', '2026-10-01T00:00:00Z')");
    expect(db.query("SELECT state, turns_reported, pending_results, ended_at FROM subagents").get()).toEqual({
      state: "running", turns_reported: 0, pending_results: null, ended_at: null,
    });
  });

  test("a state outside the four is refused", () => {
    const db = migrated();
    expect(() => db.run("INSERT INTO subagents (id, parent_session_key, name, cwd, created_at, state) VALUES ('c1', 'topic:t', 'x', '/p', 'now', 'dormant')")).toThrow();
  });

  test("it runs twice without harm, and the counts it serves use an index", () => {
    const db = migrated();
    db.exec(SQL);
    const plan = db.query("EXPLAIN QUERY PLAN SELECT COUNT(*) FROM subagents WHERE parent_session_key = ? AND state = 'running'").all("topic:t") as Array<{ detail: string }>;
    expect(plan.map((p) => p.detail).join(" ")).toContain("idx_subagents_parent_state");
  });
});
