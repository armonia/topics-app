/**
 * The migration of the self-check round: the sample table and the settings
 * column, on a synthetic database with a settings row already in it.
 *
 * @covers CHECK-01
 */
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("adds the samples table and the settings column without touching the row that was there", () => {
  const db = new Database(":memory:");
  db.run("CREATE TABLE app_settings (id INTEGER PRIMARY KEY CHECK (id = 1), auto_dispatch INTEGER)");
  db.run("INSERT INTO app_settings (id, auto_dispatch) VALUES (1, 1)");

  db.run(readFileSync(join(import.meta.dir, "../../server/db/migrations/20261122100000-topics-check.sql"), "utf8"));

  expect(db.query("SELECT auto_dispatch, topics_check_json FROM app_settings").get()).toEqual({ auto_dispatch: 1, topics_check_json: null });
  db.run("INSERT INTO topics_check_samples (at, sample_json) VALUES (1, '{}')");
  expect(db.query("SELECT COUNT(*) AS n FROM topics_check_samples").get()).toEqual({ n: 1 });
});
