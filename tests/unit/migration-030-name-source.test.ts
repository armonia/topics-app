/**
 * @covers SCHEMA-06
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { join } from "path";

const MIGRATION = join(import.meta.dir, "../../server/db/migrations/030-terminal-session-name-source.sql");

function applyMigration(names: string[]): Record<string, string> {
  const db = new Database(":memory:");
  db.exec(
    "CREATE TABLE terminal_sessions (id TEXT PRIMARY KEY, name TEXT NOT NULL, cwd TEXT NOT NULL DEFAULT '/', command TEXT, type TEXT NOT NULL DEFAULT 'shell', topic_id TEXT, cols INTEGER NOT NULL DEFAULT 120, rows INTEGER NOT NULL DEFAULT 30, skip_permissions INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT '', claude_session_id TEXT, status TEXT NOT NULL DEFAULT 'active', parent_session_key TEXT);",
  );
  const ins = db.prepare("INSERT INTO terminal_sessions (id, name, created_at) VALUES (?, ?, '')");
  names.forEach((n, i) => ins.run(String(i), n));
  db.exec(readFileSync(MIGRATION, "utf-8"));
  const out: Record<string, string> = {};
  for (const r of db.query("SELECT name, name_source FROM terminal_sessions").all() as any[]) {
    out[r.name] = r.name_source;
  }
  db.close();
  return out;
}

describe("migration 030 — name_source classification", () => {
  // The bug this guards: a fresh Claude Code session is named "Claude Code"
  // (the agent label), NOT "Terminal N". If the migration marked it 'user',
  // auto-naming would never relabel it.
  test("generic defaults (Terminal N + agent labels) stay 'default' (auto-renameable)", () => {
    const r = applyMigration(["Terminal 1", "Terminal 42", "Claude Code", "Shell", "Codex", "Claude Code Team"]);
    expect(r["Terminal 1"]).toBe("default");
    expect(r["Terminal 42"]).toBe("default");
    expect(r["Claude Code"]).toBe("default");
    expect(r["Shell"]).toBe("default");
    expect(r["Codex"]).toBe("default");
    expect(r["Claude Code Team"]).toBe("default");
  });

  test("a manually-renamed session is preserved as 'user'", () => {
    const r = applyMigration(["My deploy session", "Fix the login bug", "Terminal"]);
    expect(r["My deploy session"]).toBe("user");
    expect(r["Fix the login bug"]).toBe("user");
    expect(r["Terminal"]).toBe("user");
  });
});
