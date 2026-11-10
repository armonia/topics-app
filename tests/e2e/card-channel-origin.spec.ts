import { expect, test } from "@playwright/test";
import { mkdirSync } from "fs";
import { createTopic, deleteTopic, deleteTask } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath } from "../../shared/board";
import { canonicalTmpRoot, removeTmpDir } from "./helpers/file-project";

hermetic(test);

/**
 * A card opened by the board gateway with the channel chat as `originTopicId`
 * is born linked to that chat: the board door returns it with the opener
 * (id and name), and an unknown id is dropped instead of failing the create.
 */
const PROJECT_PATH = `${canonicalTmpRoot()}/e2e-card-channel-origin-${Date.now()}`;

test("a card born with originTopicId carries the channel chat as its opener", async ({ request }) => {
  test.info().annotations.push({ type: "spec", description: "KANBAN-103" });
  mkdirSync(PROJECT_PATH, { recursive: true });
  const projectId = projectIdForPath(PROJECT_PATH);
  const topic = await createTopic(request, `discord-thread-${Date.now()}`, { projectPath: PROJECT_PATH });
  const ids: string[] = [];
  try {
    const linked = await request.post(`${E2E_BASE}/api/boards/${projectId}/tasks`, {
      data: { text: "Card from a channel turn", status: "backlog", originTopicId: topic.id },
    });
    expect(linked.status()).toBe(201);
    const card = (await linked.json()) as { id: string };
    ids.push(card.id);

    const list = await (await request.get(`${E2E_BASE}/api/boards/${projectId}/tasks`)).json();
    const rows = (Array.isArray(list) ? list : list.tasks) as Array<{ id: string; openerTopicId?: string; openerName?: string }>;
    const mine = rows.find((t) => t.id === card.id);
    expect(mine?.openerTopicId).toBe(topic.id);
    expect(mine?.openerName).toBe(topic.name);

    const stray = await request.post(`${E2E_BASE}/api/boards/${projectId}/tasks`, {
      data: { text: "Card with an unknown origin", status: "backlog", originTopicId: "no-such-topic" },
    });
    expect(stray.status()).toBe(201);
    ids.push(((await stray.json()) as { id: string }).id);
  } finally {
    for (const id of ids) await deleteTask(request, projectId, id).catch(() => {});
    await deleteTopic(request, topic.id).catch(() => {});
    removeTmpDir(PROJECT_PATH);
  }
});
