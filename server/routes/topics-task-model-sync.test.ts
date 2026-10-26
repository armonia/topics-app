/** @covers KANBAN-80 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "../../tests/integration/helpers";
import { createTaskService } from "../services/tasks";
import type { AppContext, Topic } from "../types";
import { createTasksRouter } from "./tasks";
import { createTopicsRouter } from "./topics";

const ROOT = testTmpDir("topics-task-model-sync");
beforeAll(() => setupTestDataDir(`${ROOT}/data`));
afterAll(() => cleanupTestDataDir(ROOT));

test("changing a topic model updates its bound card", async () => {
  const ctx: AppContext = await createTestAppContext();
  const topic = {
    id: "topic-model-sync", name: "Model sync", slug: "model-sync", parentId: null, links: [],
    sessionKey: "topic:model-sync", color: "#5865f2", icon: "MessageSquare", createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), archived: false, provider: "claude-code", model: "claude-sonnet-4-6",
  } as Topic;
  ctx.saveSingleTopic(topic);

  const service = createTaskService(ctx.db);
  const card = service.create({ projectId: "project-model-sync", text: "Bound card", model: "claude-sonnet-4-6" });
  ctx.db.prepare("UPDATE tasks SET assigned_topic_id = ? WHERE id = ?").run(topic.id, card.id);

  const topics = createTopicsRouter(ctx);
  const tasks = createTasksRouter(ctx);
  const patchUrl = new URL(`http://topics.test/api/topics/${topic.id}`);
  const patch = await topics(
    new Request(patchUrl, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-5-5" }) }),
    patchUrl,
    patchUrl.pathname,
    "PATCH",
  );
  expect(patch?.status).toBe(200);

  const cardUrl = new URL(`http://topics.test/api/boards/${card.projectId}/tasks/${card.id}`);
  const response = await tasks(new Request(cardUrl), cardUrl, cardUrl.pathname, "GET");
  expect(response?.status).toBe(200);
  expect((await response!.json()).task.model).toBe("claude-sonnet-5-5");
}, 30_000);
