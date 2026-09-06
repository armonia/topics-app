/**
 * Deleting a worktree row: the topics bound to it forget the Claude session that
 * lived in the reaped checkout and degrade to their project path, still working.
 * @covers WORKTREE-03, WORKTREE-14
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createWorktreeStore } from "./worktree-store";

// Minimal but faithful schema: the two FK edges that make a reaped worktree
// orphan a topic's Claude session.
//   topics.worktree_id       → worktrees(id)      ON DELETE SET NULL
//   claude_code_sessions.session_key → topics(session_key) ON DELETE CASCADE
// With foreign_keys ON, deleting a worktree row nulls the topic's worktree_id
// but leaves the (now unresumable) claude_code_sessions row behind — that
// leftover is exactly what freezes the topic on its last turn. worktree-store's
// delete() must forget those sessions in the same step.
function seedDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  db.run(`
    CREATE TABLE projects (id TEXT PRIMARY KEY);
    CREATE TABLE worktrees (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      branch_name TEXT,
      base_ref TEXT,
      mode TEXT NOT NULL DEFAULT 'branch',
      abs_path TEXT NOT NULL UNIQUE,
      is_pushed INTEGER NOT NULL DEFAULT 0,
      branch_renamed INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ready',
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE topics (
      id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL UNIQUE,
      worktree_id TEXT REFERENCES worktrees(id) ON DELETE SET NULL
    );
    CREATE TABLE claude_code_sessions (
      session_key TEXT PRIMARY KEY,
      claude_session_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (session_key) REFERENCES topics(session_key) ON DELETE CASCADE
    );
  `);
  db.run("INSERT INTO projects (id) VALUES ('p1')");
  const now = "2026-01-01T00:00:00.000Z";
  const wt = db.prepare(
    `INSERT INTO worktrees (id, project_id, name, mode, abs_path, status, created_at, updated_at)
     VALUES (?, 'p1', ?, 'branch', ?, 'ready', ?, ?)`,
  );
  wt.run("wt1", "capitolato-fase1", "/tmp/wt1", now, now);
  wt.run("wt2", "altra-fase", "/tmp/wt2", now, now);
  const tp = db.prepare(
    "INSERT INTO topics (id, session_key, worktree_id) VALUES (?, ?, ?)",
  );
  tp.run("t1", "topic:t1", "wt1"); // bound to the worktree we'll reap
  tp.run("t2", "topic:t2", "wt2"); // bound to a survivor
  tp.run("t3", "topic:t3", null); // no worktree at all
  const cs = db.prepare(
    "INSERT INTO claude_code_sessions (session_key, claude_session_id, created_at, updated_at) VALUES (?, ?, ?, ?)",
  );
  cs.run("topic:t1", "sess-1", now, now);
  cs.run("topic:t2", "sess-2", now, now);
  cs.run("topic:t3", "sess-3", now, now);
  return db;
}

let db: Database;
beforeEach(() => {
  db = seedDb();
});

function sessionKeys(): string[] {
  return db
    .prepare("SELECT session_key FROM claude_code_sessions ORDER BY session_key")
    .all()
    .map((r: any) => r.session_key);
}

describe("worktreeStore.delete — reap forgets orphaned sessions", () => {
  test("forgets the Claude session of every topic bound to the reaped worktree", () => {
    const store = createWorktreeStore(db);
    expect(store.delete("wt1")).toBe(true);

    // The bound topic's session pointer is gone (would be unresumable anyway).
    expect(sessionKeys()).toEqual(["topic:t2", "topic:t3"]);
    // The worktree row itself is gone.
    expect(db.prepare("SELECT id FROM worktrees WHERE id = 'wt1'").get()).toBeNull();
  });

  test("preserves sessions of topics bound to other worktrees or none", () => {
    const store = createWorktreeStore(db);
    store.delete("wt1");
    // Survivors keep their resumable sessions intact.
    expect(
      db.prepare("SELECT claude_session_id FROM claude_code_sessions WHERE session_key = 'topic:t2'").get(),
    ).toEqual({ claude_session_id: "sess-2" });
    expect(
      db.prepare("SELECT claude_session_id FROM claude_code_sessions WHERE session_key = 'topic:t3'").get(),
    ).toEqual({ claude_session_id: "sess-3" });
  });

  test("the topic survives the reap, gracefully degraded to its project path", () => {
    const store = createWorktreeStore(db);
    store.delete("wt1");
    // ON DELETE SET NULL: the topic is NOT deleted, just unbound — the next
    // turn spawns fresh in the base project (seeded with the DB history recap).
    const row: any = db.prepare("SELECT worktree_id FROM topics WHERE id = 't1'").get();
    expect(row).not.toBeNull();
    expect(row.worktree_id).toBeNull();
  });

  test("reaping a worktree with no bound topic touches no sessions", () => {
    // wt2 is bound by t2; reap an orphan worktree instead.
    db.prepare(
      `INSERT INTO worktrees (id, project_id, name, mode, abs_path, status, created_at, updated_at)
       VALUES ('wt3', 'p1', 'nessuno', 'branch', '/tmp/wt3', 'ready', '2026-01-01', '2026-01-01')`,
    ).run();
    const store = createWorktreeStore(db);
    expect(store.delete("wt3")).toBe(true);
    expect(sessionKeys()).toEqual(["topic:t1", "topic:t2", "topic:t3"]);
  });

  test("deleting a nonexistent worktree is a no-op returning false", () => {
    const store = createWorktreeStore(db);
    expect(store.delete("does-not-exist")).toBe(false);
    expect(sessionKeys()).toEqual(["topic:t1", "topic:t2", "topic:t3"]);
  });
});

describe("worktreeStore.getByAbsPath - a directory names its worktree", () => {
  test("finds the row checked out at that exact path", () => {
    const store = createWorktreeStore(db);
    const found = store.getByAbsPath("/tmp/wt1");
    expect(found?.id).toBe("wt1");
    expect(found?.projectId).toBe("p1");
  });

  test("a path nobody checked out answers null, and so does a prefix of one", () => {
    const store = createWorktreeStore(db);
    expect(store.getByAbsPath("/tmp/elsewhere")).toBeNull();
    // Deliberately exact: `/tmp/wt1/server` is INSIDE a worktree but is not the
    // worktree, and a lookup that answered here would hand the sweep and the
    // spawn route a row for a directory that is only a descendant.
    expect(store.getByAbsPath("/tmp/wt1/server")).toBeNull();
  });
});
