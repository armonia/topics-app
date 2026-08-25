/**
 * getTopicWorkspaceForSession — the OS cwd a session's CLI child spawns in.
 *
 * Regression guard for the "chat keeps freezing" bug (2026-07-18): a plain
 * project chat was spawned in HOME while its awareness block said the project
 * dir, so "analizza tutta la repository" thrashed HOME (find ~/Projects,
 * wandering into the wrong repo, 60s no-data timeouts). The helper must resolve
 * the topic's real working dir — a ready worktree's absPath first, else the
 * project checkout — and fall back to null (→ caller uses HOME) only when
 * nothing is bound or the path is missing.
 * @covers CCPROV-05
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDatabase, closeDatabase, getDatabase } from "../db";
import { getTopicWorkspaceForSession } from "./claude-code";

let tmpRoot: string;
let projectDir: string;
let worktreeDir: string;
let worktreeDir2: string;

function seedTopic(sessionKey: string, projectPath: string | null, worktreeId: string | null): void {
  const now = new Date().toISOString();
  getDatabase()
    .prepare(
      `INSERT INTO topics (id, name, slug, session_key, project_path, worktree_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(sessionKey, "T", sessionKey, sessionKey, projectPath, worktreeId, now, now);
}

function seedProject(): void {
  const now = new Date().toISOString();
  getDatabase()
    .prepare(
      `INSERT OR IGNORE INTO projects (id, name, slug, path, archived, created_at, updated_at)
       VALUES ('proj', 'Proj', 'proj', ?, 0, ?, ?)`,
    )
    .run(projectDir, now, now);
}

function seedWorktree(id: string, absPath: string, status: string): void {
  seedProject(); // satisfy worktrees.project_id → projects(id) FK
  const now = new Date().toISOString();
  getDatabase()
    .prepare(
      `INSERT INTO worktrees (id, project_id, name, mode, abs_path, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, "proj", id, "branch", absPath, status, now, now);
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "cc-workspace-test-"));
  const migDir = join(tmpRoot, "server", "db", "migrations");
  mkdirSync(migDir, { recursive: true });
  const realMigDir = join(import.meta.dir, "..", "db", "migrations");
  for (const f of readdirSync(realMigDir)) {
    if (!f.endsWith(".sql")) continue;
    writeFileSync(join(migDir, f), readFileSync(join(realMigDir, f), "utf-8"));
  }
    initDatabase(tmpRoot);

  projectDir = join(tmpRoot, "Projects", "demo");
  worktreeDir = join(tmpRoot, "worktrees", "demo-wt");
  worktreeDir2 = join(tmpRoot, "worktrees", "demo-wt-2");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(worktreeDir, { recursive: true });
  mkdirSync(worktreeDir2, { recursive: true });
});

afterAll(() => {
  try { closeDatabase(); } catch {}
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe("getTopicWorkspaceForSession", () => {
  test("project-bound topic → the project checkout (the frozen-chat case)", () => {
    seedTopic("topic:proj", projectDir, null);
    expect(getTopicWorkspaceForSession("topic:proj")).toBe(projectDir);
  });

  test("ready worktree wins over the project path", () => {
    seedWorktree("wt-ready", worktreeDir, "ready");
    seedTopic("topic:wt", projectDir, "wt-ready");
    expect(getTopicWorkspaceForSession("topic:wt")).toBe(worktreeDir);
  });

  test("pending/errored worktree falls through to the project path", () => {
    seedWorktree("wt-pending", worktreeDir2, "pending");
    seedTopic("topic:wtpending", projectDir, "wt-pending");
    expect(getTopicWorkspaceForSession("topic:wtpending")).toBe(projectDir);
  });

  test("missing project dir → null (caller falls back to HOME, never spawns in a dead cwd)", () => {
    seedTopic("topic:gone", join(tmpRoot, "does-not-exist"), null);
    expect(getTopicWorkspaceForSession("topic:gone")).toBeNull();
  });

  test("topic with no project → null", () => {
    seedTopic("topic:noproj", null, null);
    expect(getTopicWorkspaceForSession("topic:noproj")).toBeNull();
  });

  test("unknown session → null", () => {
    expect(getTopicWorkspaceForSession("topic:unknown")).toBeNull();
  });

  test("leading ~ in project_path is expanded against HOME", () => {
    const prevHome = process.env.HOME;
    process.env.HOME = tmpRoot; // so ~/Projects/demo resolves to an existing dir
    try {
      seedTopic("topic:tilde", "~/Projects/demo", null);
      expect(getTopicWorkspaceForSession("topic:tilde")).toBe(projectDir);
    } finally {
      process.env.HOME = prevHome;
    }
  });
});
