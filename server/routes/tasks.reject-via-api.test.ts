/**
 * A rejection sent through the board route WITHOUT the interface marker (an
 * MCP tool, a script) must still reach the agent as a rejection. The row it
 * writes has to carry the human author, or `pendingHumanReopen` cannot find it
 * after a restart. Goes through the route so it turns red if the author ever
 * starts to vary with the caller.
 *
 * @covers KANBAN-113
 */
import { test, expect, beforeEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTasksRouter } from "./tasks";
import { createTaskService, projectIdForPath } from "../services/tasks";
import { freshDb, makeCtx, call } from "./tasks-test-support";

const REPO = "/repo";
const PID = projectIdForPath(REPO);
let db: Database;

beforeEach(() => {
  db = freshDb();
  db.run("CREATE TABLE messages (id TEXT PRIMARY KEY, session_key TEXT NOT NULL, role TEXT, content TEXT, timestamp TEXT, blocks TEXT)");
});

test("a reject with no interface header is still the human's rejection", async () => {
  const router = createTasksRouter(makeCtx(db, []), undefined, { listProjectDirs: () => [REPO] });
  const t = await (await call(router, "POST", `/api/boards/${PID}/tasks`, { text: "feature" }))!.json();
  db.run("INSERT INTO topics (id, session_key) VALUES ('tp1', 'topic:tp1')");
  db.run("UPDATE tasks SET status = 'review', assigned_topic_id = 'tp1' WHERE id = ?", [t.id]);
  const res = await call(router, "POST", `/api/boards/${PID}/tasks/${t.id}/review`, { decision: "reject", comment: "rifai la parte due" }, {});
  expect(res!.status).toBe(200);
  const row = db.prepare("SELECT author, origin FROM task_comments WHERE task_id = ? AND content = ?").get(t.id, "rifai la parte due") as { author: string; origin: string };
  expect(row.origin).toBe("api");
  expect(row.author).toBe("user");
  const pending = createTaskService(db).pendingHumanReopen({ taskId: t.id });
  expect(pending?.text).toBe("rifai la parte due");
});
