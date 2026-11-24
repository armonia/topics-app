/**
 * The worktree settings migration: six nullable columns on a settings row that
 * already exists, none of which may change what that row said before.
 *
 * @covers WORKTREE-STD-01
 */
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("adds the six columns as NULL without touching the existing row", () => {
  const db = new Database(":memory:");
  db.run("CREATE TABLE app_settings (id INTEGER PRIMARY KEY CHECK (id = 1), auto_dispatch INTEGER)");
  db.run("INSERT INTO app_settings (id, auto_dispatch) VALUES (1, 1)");

  db.run(readFileSync(join(import.meta.dir, "../../server/db/migrations/20261124100000-app-settings-worktrees.sql"), "utf8"));

  expect(
    db.query(
      "SELECT auto_dispatch, worktree_root, worktree_max_per_project, worktree_disk_floor_gb, cargo_target_mode, gc_foreign, worktree_abandon_days FROM app_settings",
    ).get(),
  ).toEqual({
    auto_dispatch: 1,
    worktree_root: null,
    worktree_max_per_project: null,
    worktree_disk_floor_gb: null,
    cargo_target_mode: null,
    gc_foreign: null,
    worktree_abandon_days: null,
  });
});
