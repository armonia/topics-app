import { test } from "./fixtures/layout.fixture";
import { expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "fs";
import { createTopic, deleteTask, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath } from "../../shared/board";
import { canonicalTmpRoot, removeTmpDir } from "./helpers/file-project";

hermetic(test);

/**
 * IN THE CARD'S DRAWER A COMMAND DOES NOT TURN INTO PROSE IN SILENCE (CMDUI-08).
 *
 * Typed in the drawer, `/compact` would reach the agent as «Human update on
 * task …», a sentence. The drawer says where commands are given and offers
 * the agent's chat; Enter still sends the text, as before.
 *
 * @covers CMDUI-08
 */

const PROJECT_PATH = `${canonicalTmpRoot()}/e2e-cmdhint-${Date.now()}`;
const PROJECT_ID = projectIdForPath(PROJECT_PATH);
const TASK = `Card col comando ${Date.now()}`;

async function openGlobalBoard(page: Page) {
  await page.getByTestId("pane-add-menu-trigger").first().click();
  await page.getByTestId("pane-add-menu-board").click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15000 });
}

test.describe("the drawer's composer and a command", () => {
  test.describe.configure({ timeout: 120_000 });
  let projectTopic: string | null = null;
  let session: string | null = null;
  let taskId: string | null = null;

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-cmdhint" }));
    projectTopic = (await createTopic(request, "E2E-CmdHint", { projectPath: PROJECT_PATH })).id;
    session = (await createTopic(request, `Sessione del comando ${Date.now()}`)).id;
    const res = await request.post(`${E2E_BASE}/api/boards/${PROJECT_ID}/tasks`, { data: { text: TASK } });
    taskId = ((await res.json()) as { id: string }).id;
    const bound = await request.post(`${E2E_BASE}/api/test/tasks/${taskId}/bind-topic`, { data: { topicId: session, dispatchState: "working" } });
    expect(bound.ok()).toBe(true);
  });

  test.afterAll(async ({ request }) => {
    if (taskId) await deleteTask(request, PROJECT_ID, taskId);
    for (const id of [session, projectTopic]) if (id) await deleteTopic(request, id);
    removeTmpDir(PROJECT_PATH);
  });

  test("/compact in the drawer shows the line with «Apri la sessione», which opens the agent's chat", async ({ page }) => {
    await resetPaneStore(page.request, []);
    await page.goto("/");
    await openGlobalBoard(page);
    const card = page.locator(`[data-task-card="${taskId}"]`);
    await expect(card).toBeVisible({ timeout: 15000 });
    await card.getByText(TASK).click();
    const drawer = page.getByTestId("task-detail-drawer");
    await expect(drawer).toBeVisible({ timeout: 15000 });

    const field = drawer.getByTestId("task-reply-input");
    await field.fill("una nota qualsiasi");
    await expect(drawer.getByTestId("board-command-hint")).toHaveCount(0);
    await field.fill("/compact");
    const hint = drawer.getByTestId("board-command-hint");
    await expect(hint).toContainText("I comandi vanno dati nella chat dell'agente");
    // A skill of the person's is not a command of the map: no line.
    await field.fill("/vai fai il bug");
    await expect(hint).toHaveCount(0);
    await field.fill("/compact");
    await hint.getByTestId("board-command-open-session").click();
    await expect(page.getByTestId("chat-task-card-strip")).toContainText(TASK, { timeout: 15000 });
  });
});
