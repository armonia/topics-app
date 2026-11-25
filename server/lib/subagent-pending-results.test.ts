/**
 * `parentHasPendingResults` feeds the "chat is about to resume" indicator.
 * A child that was stopped or lost can never run again, so a result it never
 * delivered must not keep the indicator lit (card 0f8f8b9b).
 * @covers SUBAGENT-14
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parentHasPendingResults } from "./subagent-store";

const SQL = readFileSync(resolve(import.meta.dir, "../db/migrations/20261001203100-subagents.sql"), "utf8");

function dbWith(state: string, pending: string | null): Database {
  const db = new Database(":memory:");
  db.exec(SQL);
  db.run("INSERT INTO subagents (id, parent_session_key, name, cwd, created_at, state, pending_results) VALUES ('c1', 'topic:t', 'scout', '/p', 'now', ?, ?)", [state, pending]);
  return db;
}

describe("parentHasPendingResults", () => {
  test("a live child with an undelivered result counts", () => {
    expect(parentHasPendingResults(dbWith("running", "[{}]") as never, "topic:t")).toBe(true);
  });
  test.each(["stopped", "lost"])("a %s child does not", (state) => {
    expect(parentHasPendingResults(dbWith(state, "[{}]") as never, "topic:t")).toBe(false);
  });
  test("no pending result, no indicator", () => {
    expect(parentHasPendingResults(dbWith("running", null) as never, "topic:t")).toBe(false);
  });
});
