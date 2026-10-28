/**
 * Migration 20261028163640 (created_by, unowned_alerted_at), executed for real:
 * the .sql file itself, on a database that already has cards in it.
 * @covers KANBAN-05
 */
import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("migration 20261028163640 run for real on a database that already has cards", () => {
  const MIGRATION = join(import.meta.dir, "migrations", "20261028163640-task-created-by.sql");

  test("stamps the cards sitting in backlog, leaves the rest, adds both columns and the index", () => {
    // The columns of `tasks` the migration reads, as they were before it.
    const old = new Database(":memory:");
    old.run("CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT, archived INTEGER DEFAULT 0, parent_task_id TEXT, updated_at TEXT)");
    const insert = (id: string, status: string, archived: number) =>
      old.run("INSERT INTO tasks (id, status, archived, parent_task_id, updated_at) VALUES (?, ?, ?, NULL, '2026-10-01T00:00:00.000Z')", [id, status, archived]);
    insert("in-backlog", "backlog", 0);
    insert("archived-backlog", "backlog", 1);
    insert("in-todo", "todo", 0);

    old.exec(readFileSync(MIGRATION, "utf8"));

    const row = (id: string) => old.query("SELECT created_by, unowned_alerted_at FROM tasks WHERE id = ?").get(id) as
      { created_by: string | null; unowned_alerted_at: string | null };
    // Old cards have no author, and the ones in backlog now are marked as already alerted.
    expect(row("in-backlog").created_by).toBeNull();
    expect(Date.parse(row("in-backlog").unowned_alerted_at!)).toBeGreaterThan(Date.parse("2026-10-01T00:00:00.000Z"));
    expect(row("archived-backlog").unowned_alerted_at).toBeNull();
    expect(row("in-todo").unowned_alerted_at).toBeNull();
    expect(old.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_tasks_backlog_unowned'").get()).not.toBeNull();

    // And the sweep's own predicate does not return the stamped card, however old.
    old.run("UPDATE tasks SET created_by = 'agent:jarvis'");
    const hits = old.query("SELECT id FROM tasks WHERE status = 'backlog' AND archived = 0 AND (unowned_alerted_at IS NULL OR unowned_alerted_at < updated_at)").all();
    expect(hits).toEqual([]);
  });
});
