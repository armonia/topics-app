/**
 * @covers KANBAN-96
 */
import { expect, test } from "bun:test";
import { createTasksRouter } from "./tasks";
import { freshDb, makeCtx, call } from "./tasks-test-support";

test("session peek uses and follows the active stream instead of the stored message", async () => {
  const db = freshDb();
  const broadcasts: unknown[] = [];
  const activeStreams = new Map<string, { messageId: string; content: string; startedAt: string }>([
    ["s1", { messageId: "message-live", content: "testo in corso", startedAt: "turn-start" }],
  ]);
  const ctx = {
    ...makeCtx(db, broadcasts),
    activeStreams,
    getTopicById: () => ({ sessionKey: "s1" }),
    getMessageById: () => null,
  } as never;
  const router = createTasksRouter(ctx);

  db.run("INSERT INTO topics (id, session_key) VALUES ('topic-1', 's1')");
  db.run(`INSERT INTO tasks (id, project_id, text, status, priority, kanban_order, created_at, updated_at,
    assigned_topic_id, dispatch_state, in_progress_at)
    VALUES ('task-1', 'board-1', 'task', 'in_progress', 2, 1, 'now', 'now', 'topic-1', 'working', 'stored-start')`);
  db.run(`CREATE TABLE messages (
    id TEXT PRIMARY KEY, session_key TEXT, role TEXT, content TEXT, timestamp TEXT, sort_order INTEGER
  )`);
  db.run("INSERT INTO messages (id, session_key, role, content, timestamp, sort_order) VALUES ('old', 's1', 'assistant', 'testo già salvato', 'stored-time', 1)");

  const read = async () => {
    const response = (await call(router, "GET", "/api/all-boards/tasks/task-1/peek"))!;
    expect(response.status).toBe(200);
    return (await response.json() as { peek: { since: string; lines: string[] } }).peek;
  };

  const first = await read();
  expect(first.since).toBe("turn-start");
  expect(first.lines).toEqual(["testo in corso"]);
  activeStreams.get("s1")!.content += "\nseconda riga";
  expect((await read()).lines).toEqual(["testo in corso", "seconda riga"]);
  db.close();
});
