/**
 * board-card-creator.spec.ts - who opened a card is visible on it (card a7ba2d05).
 *
 * A person's card says «tu», an agent's card names the chat it came from, an
 * agent's card born without context is flagged «incompleta», an old card with no
 * author stays open and readable (no chip), and the Mine/Others filter cuts the
 * board by creator.
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane, deleteTask } from "./helpers/api-fixtures";
import { mkdirSync, writeFileSync } from "fs";
import { canonicalTmpDir, removeTmpDir } from "./helpers/file-project";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath as boardIdForPath } from "../../shared/board";

hermetic(test);

const BASE = E2E_BASE;
const PROJECT_PATH = canonicalTmpDir("e2e-creator");

const PROJECT_ID = boardIdForPath(PROJECT_PATH);


let projectTopicId: string | null = null;
const createdTasks: string[] = [];

async function createTask(request: any, body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<{ id: string }> {
  const res = await request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, { data: body, headers });
  expect(res.ok()).toBe(true);
  const task = (await res.json()) as { id: string };
  createdTasks.push(`${PROJECT_ID}:${task.id}`);
  return task;
}

async function openProjectBoard(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /e2e-creator/);
  await expect(btn).toBeVisible({ timeout: 10000 });
  await btn.click();
  await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 10000 });

  const triggers = page.getByTestId("pane-add-menu-trigger");
  const count = await triggers.count();
  const item = page.getByTestId("pane-add-menu-kanban");
  let opened = false;
  for (let i = count - 1; i >= 0; i--) {
    const t = triggers.nth(i);
    if (!(await t.isVisible().catch(() => false))) continue;
    if (!(await t.click({ timeout: 3000 }).then(() => true, () => false))) continue;
    if (await item.waitFor({ state: "visible", timeout: 2000 }).then(() => true, () => false)) { opened = true; break; }
    await page.keyboard.press("Escape");
  }
  if (!opened) throw new Error("no + menu with a Board (kanban) entry found");
  await item.click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 10000 });
}


test.describe("Creatore sulla card", () => {
  test.describe.configure({ timeout: 90_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-creator" }, null, 2));
    const topic = await createTopic(request, "E2E-Creator", { projectPath: PROJECT_PATH });
    projectTopicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    for (const key of [...createdTasks].reverse()) {
      const [pid, tid] = key.split(":");
      await deleteTask(request, pid, tid);
    }
    if (projectTopicId) await deleteTopic(request, projectTopicId);
    removeTmpDir(PROJECT_PATH);
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, PROJECT_PATH);
    await seedProjectPane(page.request, PROJECT_PATH);
  });

  test("il creatore si vede sulla card, l'incompleta è segnata, il filtro Mie/Altri taglia", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-05" });
    // A person's card (the interface marks itself), an agent's bare card, a complete one.
    const mine = await createTask(request, { text: "Card mia" }, { "X-Topics-Action-Origin": "interface" });
    const bare = await createTask(request, { text: "Card d'agente senza contesto", createdBy: "agent:jarvis" });
    const full = await createTask(request, {
      text: "Card d'agente completa", createdBy: "agent:jarvis",
      description: "Contesto abbastanza lungo da bastare per finire da sola.", bar: "bun test", source: "chat:e2e",
    });

    await page.goto("/");
    await openProjectBoard(page);

    await expect(page.locator(`[data-task-card="${mine.id}"]`).getByTestId("card-created-by")).toHaveAttribute("data-created-by-kind", "human");
    const bareCard = page.locator(`[data-task-card="${bare.id}"]`);
    await expect(bareCard.getByTestId("card-created-by")).toHaveText("J");
    await expect(bareCard.getByTestId("card-created-by")).toHaveAttribute("title", /jarvis/);
    await expect(bareCard.getByTestId("card-incomplete")).toBeVisible();
    await expect(page.locator(`[data-task-card="${full.id}"]`).getByTestId("card-incomplete")).toHaveCount(0);

    const filter = page.getByTestId("filter-creator");
    await filter.click(); // Mine
    await expect(page.locator(`[data-task-card="${mine.id}"]`)).toBeVisible();
    await expect(page.locator(`[data-task-card="${bare.id}"]`)).toHaveCount(0);
    await filter.click(); // Others
    await expect(page.locator(`[data-task-card="${mine.id}"]`)).toHaveCount(0);
    await expect(page.locator(`[data-task-card="${bare.id}"]`)).toBeVisible();
    await filter.click(); // All
    await expect(page.locator(`[data-task-card="${mine.id}"]`)).toBeVisible();
  });
});
