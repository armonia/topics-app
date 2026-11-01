/**
 * Review of card b3fa8223, deferred: `human_ask` is written only by the card's
 * own side, and a subtask has no workflow column whichever door moves it.
 */
import { test, expect, beforeEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTaskService } from "./tasks";
import { freshDb, PID } from "./tasks-test-db";
import { writeBoardWorkflow } from "./board-workflow";
import { _resetAiReviewNotices } from "./ai-review-notice";

let db: Database;

beforeEach(() => {
  db = freshDb();
  db.run("CREATE TABLE board_workflows (scope TEXT PRIMARY KEY, preset TEXT NOT NULL, updated_at TEXT NOT NULL)");
  db.run("INSERT INTO topics (id) VALUES ('topic-worker')");
  db.run("INSERT INTO topics (id) VALUES ('topic-stranger')");
  writeBoardWorkflow(db, PID, "armonia", "2026-10-31T10:00:00.000Z");
  _resetAiReviewNotices();
});

function workedCard() {
  const svc = createTaskService(db);
  const t = svc.create({ projectId: PID, text: "worked card", status: "todo", createdBy: "agent:api", priority: 1, description: "bar" });
  db.run("UPDATE tasks SET status = 'in_progress', assigned_topic_id = 'topic-worker', dispatch_state = 'working' WHERE id = ?", [t.id]);
  return { svc, id: t.id };
}

test("a stranger agent cannot plant human_ask on a worked card", () => {
  const { svc, id } = workedCard();
  expect(() => svc.update({ taskId: id, actor: "agent", by: "stranger", agentTopicId: "topic-stranger", patch: { humanAsk: "planted" } })).toThrow();
  const delivered = svc.update({ taskId: id, actor: "agent", by: "worker", agentTopicId: "topic-worker", patch: { status: "review", summary: "done" } });
  expect(delivered.humanAsk ?? null).toBeNull();
});

test("a stranger agent cannot plant human_ask on a card in AI review", () => {
  const { svc, id } = workedCard();
  svc.update({ taskId: id, actor: "agent", by: "worker", agentTopicId: "topic-worker", patch: { status: "review", summary: "done" } });
  expect(() => svc.update({ taskId: id, actor: "agent", by: "stranger", agentTopicId: "topic-stranger", patch: { humanAsk: "planted" } })).toThrow();
});

test("the worker still writes its own human_ask", () => {
  const { svc, id } = workedCard();
  const t = svc.update({ taskId: id, actor: "agent", by: "worker", agentTopicId: "topic-worker", patch: { status: "review", summary: "done", humanAsk: "Look at this" } });
  expect(t.humanAsk).toBe("Look at this");
});

test("a subtask moved to review through update() gets no stage", () => {
  const { svc, id } = workedCard();
  const sub = svc.create({ projectId: PID, text: "step", status: "in_progress", createdBy: "agent:api", parentTaskId: id } as never);
  const t = svc.update({ taskId: sub.id, actor: "agent", by: "worker", agentTopicId: "topic-worker", patch: { status: "review", summary: "step done" } });
  expect(t.status).toBe("review");
  expect(t.stage ?? null).toBeNull();
  const notices = db.query("SELECT COUNT(*) AS n FROM task_comments WHERE task_id = ? AND author = 'system'").get(sub.id) as { n: number } | null;
  expect(notices?.n ?? 0).toBe(0);
});
