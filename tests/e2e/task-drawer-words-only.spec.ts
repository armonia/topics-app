/**
 * The column of a task drawer carries WORDS only (card e6e4d61d, study §8):
 * the person's and the agent's sentences, plus ONE live status line while the
 * agent works. The dispatcher's chronicle moves into the «Details» panel.
 */
import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, deleteTask } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath } from "../../shared/board";
import { canonicalTmpRoot } from "./helpers/file-project";

hermetic(test);

const STAMP = Date.now();
const PROJECT_PATH = `${canonicalTmpRoot()}/e2e-words-only-${STAMP}`;
const PROJECT_ID = projectIdForPath(PROJECT_PATH);
const SYSTEM_LINE = `SYSTEM-CHRONICLE-${STAMP}`;
const AGENT_WORDS = `AGENT-WORDS-${STAMP}`;

test.describe("Task drawer: words and one status line", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  let topicId = "";
  let taskId = "";

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-words-only" }));
    topicId = (await createTopic(request, `words-only-${STAMP}`)).id;
    const sessionKey = `topic:${topicId.slice(0, 8)}`;
    await seedMessage(request, { sessionKey, role: "user", content: "fix it" });
    await seedMessage(request, {
      sessionKey, role: "assistant", content: AGENT_WORDS,
    });
    await seedMessage(request, {
      sessionKey, role: "assistant", content: "",
      toolCalls: [{ id: `wo-${STAMP}`, name: "Bash", args: { command: "bun test" }, status: "running", startedAt: Date.now() }],
    });
    const res = await request.post(`${E2E_BASE}/api/boards/${PROJECT_ID}/tasks`, { data: { text: `Words only ${STAMP}` } });
    expect(res.ok()).toBe(true);
    taskId = ((await res.json()) as { id: string }).id;
    const bind = await request.post(`${E2E_BASE}/api/test/tasks/${taskId}/bind-topic`, { data: { topicId, dispatchState: "working" } });
    expect(bind.ok()).toBe(true);
    const note = await request.post(`${E2E_BASE}/api/test/tasks/${taskId}/anchored-comment`, {
      data: { content: SYSTEM_LINE, author: "system", messageId: "m-system" },
    });
    expect(note.ok()).toBe(true);
  });

  test.afterAll(async ({ request }) => {
    if (taskId) await deleteTask(request, PROJECT_ID, taskId);
    if (topicId) await deleteTopic(request, topicId);
  });

  test("no system chronicle in the column, one live status line, chronicle under Details", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-102" });
    await goToApp(page);
    await page.goto(`/task/${taskId}`);
    const column = page.getByTestId("task-conversation-scroll");
    await expect(column).toBeVisible({ timeout: 20_000 });
    await expect(column.getByText(AGENT_WORDS)).toBeVisible();
    await expect(column.getByText(SYSTEM_LINE)).toHaveCount(0);
    await expect(column.getByTestId("task-service-fold")).toHaveCount(0);
    await expect(page.getByTestId("task-session-live")).toHaveCount(1);
    await expect(page.getByTestId("turn-running-tool")).toContainText("bun test");

    await page.getByTestId("task-details-toggle").click();
    await expect(page.getByTestId("task-chronicle").getByText(SYSTEM_LINE)).toBeVisible();
  });
});
