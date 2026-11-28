/**
 * A tiny database with ONE project and one topic inside it, for the tests of
 * the project-pause gates: each gate test pauses the project, drives its door
 * and counts the turns that started.
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { projectIdForPath } from "../../shared/board";
import { PROJECT_QUOTA_SCHEMA } from "./project-quota-schema";
import { openPauseIfNeeded, continueProject } from "../../server/services/project-pause";
import { fireProjectResumed } from "../../server/services/turn-gate";

const QUOTA_MIGRATION = PROJECT_QUOTA_SCHEMA;

export const PAUSED_PROJECT_PATH = "/tmp/pause-fixture/proj";
export const PAUSED_PROJECT_ID = projectIdForPath(PAUSED_PROJECT_PATH);
export const PAUSED_TOPIC_ID = "topic-in-paused-project";

export function pausedProjectDb(): Database {
  const db = new Database(":memory:");
  db.run("CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL, slug TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0)");
  db.run("CREATE TABLE worktrees (abs_path TEXT NOT NULL, project_id TEXT NOT NULL)");
  db.run("CREATE TABLE topics (id TEXT PRIMARY KEY, project_path TEXT)");
  db.exec(QUOTA_MIGRATION);
  db.run("INSERT INTO projects (id, path, slug) VALUES ('p1', ?, 'proj')", [PAUSED_PROJECT_PATH]);
  db.run("INSERT INTO topics (id, project_path) VALUES (?, ?)", [PAUSED_TOPIC_ID, PAUSED_PROJECT_PATH]);
  return db;
}

/** Opens the pause the way the sweep does (points over the default limit). */
export function pauseFixtureProject(db: Database): void {
  // A project with no row has no limit (until 64b1f052), so the fixture gets an explicit one.
  db.run("INSERT OR IGNORE INTO project_quota (project_id, limit_24h_pct, updated_at) VALUES (?, 10, 'x')", [PAUSED_PROJECT_ID]);
  openPauseIfNeeded(db, PAUSED_PROJECT_ID, 50);
}

/** "Continua": closes the pause and fires the resume, like the route does. */
export function resumeFixtureProject(db: Database): void {
  continueProject(db, PAUSED_PROJECT_ID, 50);
  fireProjectResumed(PAUSED_PROJECT_ID);
}

/** Gives the project an explicit 10 point limit (no row means no limit until 64b1f052) and opens its pause. */
export function openPauseWithLimit(db: Database, projectId: string, points24h: number, nowMs?: number): boolean {
  db.run("INSERT OR IGNORE INTO project_quota (project_id, limit_24h_pct, updated_at) VALUES (?, 10, 'x')", [projectId]);
  return openPauseIfNeeded(db, projectId, points24h, nowMs);
}
