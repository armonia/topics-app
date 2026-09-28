/**
 * WHICH SESSION THE SPAWN TREATS AS A BOARD AGENT.
 *
 * `dispatched` picks the system prompt that tells an agent to wait for its
 * commands inside the turn instead of ending it on a wake. A fan-out binds
 * only attempt 1 in `tasks.assigned_topic_id`; attempts 2..N live in
 * `task_attempts`. The spawn asked the first column only, so attempts 2..N
 * read an ordinary chat's prompt ("so you can end your turn") in the one
 * flow judged the moment its single turn ends (verifiers of 28/09).
 *
 * @covers CMDRUN-04
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, getDatabase, initDatabase } from "../db";
import { getTopicSpawnOverridesForSession } from "./claude-code";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const NOW = "2026-09-28T00:00:00.000Z";
let tempRoot: string;
// DATA_DIR wins over the root passed to initDatabase, and an earlier file in
// the same shard can leave it set (see global-orchestrator-provider-guard).
let previousDataDir: string | undefined;

beforeEach(() => {
  try { closeDatabase(); } catch { /* no database open yet */ }
  tempRoot = mkdtempSync(join(tmpdir(), "topics-spawn-overrides-"));
  previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = join(tempRoot, "data");
  initDatabase(REPO_ROOT, tempRoot);
});

afterEach(() => {
  try { closeDatabase(); } catch { /* cleanup */ }
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  try { rmSync(tempRoot, { recursive: true, force: true }); } catch { /* scratch */ }
});

function seedTopic(id: string): void {
  getDatabase().prepare(
    "INSERT INTO topics (id, name, slug, session_key, project_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, id, id, `topic:${id}`, "/work/project", NOW, NOW);
}

test("every attempt of a fan-out is a board agent at spawn, not only attempt 1", () => {
  for (const id of ["att1", "att2", "chat"]) seedTopic(id);
  const db = getDatabase();
  db.prepare(
    "INSERT INTO tasks (id, project_id, text, status, created_at, updated_at, assigned_topic_id) VALUES ('k1', 'p1', 'fan-out', 'in_progress', ?, ?, 'att1')",
  ).run(NOW, NOW);
  db.prepare(
    "INSERT INTO task_attempts (id, task_id, idx, topic_id, created_at) VALUES ('a1', 'k1', 1, 'att1', ?), ('a2', 'k1', 2, 'att2', ?)",
  ).run(NOW, NOW);

  expect(getTopicSpawnOverridesForSession("topic:att1").dispatched).toBe(true);
  expect(getTopicSpawnOverridesForSession("topic:att2").dispatched).toBe(true);
  expect(getTopicSpawnOverridesForSession("topic:chat").dispatched).toBe(false);
});
