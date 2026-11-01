import { expect, test } from "@playwright/test";
import { mkdirSync } from "fs";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, deleteTask } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath } from "../../shared/board";
import { canonicalTmpRoot, removeTmpDir } from "./helpers/file-project";

hermetic(test);

/**
 * A request that becomes a card is confirmed in the chat that asked for it:
 * the agent opens a card through the session door and the chat gets the "became a card" line
 * with the title and a link, with no turn started.
 * Two states, so a clip: the chat before, and the chat with the line.
 */
const BASE = E2E_BASE;
const PROJECT_PATH = `${canonicalTmpRoot()}/e2e-card-origin-${Date.now()}`;
const TITLE = "Conferma di origine: la card nasce dalla chat";

test("the chat that asked is told the request became a card", async ({ page, request }) => {
  test.info().annotations.push({ type: "spec", description: "KANBAN-103" });
  mkdirSync(PROJECT_PATH, { recursive: true });
  const topic = await createTopic(request, `card-origin-${Date.now()}`, { projectPath: PROJECT_PATH });
  let taskId: string | null = null;
  try {
    await goToApp(page);
    await openTopic(page, topic.name);

    const sessionKey = `topic:${topic.id.slice(0, 8)}`;
    const res = await request.post(`${BASE}/api/sessions/${encodeURIComponent(sessionKey)}/tasks`, {
      data: { text: TITLE },
    });
    expect(res.status()).toBe(201);
    taskId = ((await res.json()) as { id: string }).id;

    const line = page.getByText("È diventata una card", { exact: false });
    await expect(line).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(TITLE).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Apri la card" })).toHaveAttribute("href", new RegExp(`/task/${taskId}`));
  } finally {
    if (taskId) await deleteTask(request, projectIdForPath(PROJECT_PATH), taskId).catch(() => {});
    await deleteTopic(request, topic.id).catch(() => {});
    removeTmpDir(PROJECT_PATH);
  }
});
