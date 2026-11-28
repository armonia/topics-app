/**
 * board-card-snooze.spec.ts — «Rimanda a» (snooze to a date) from the card menu.
 *
 * The card parks in backlog with a date (`wakeAt`) and returns to todo by
 * itself at the server tick (`tasks-wake.test.ts` proves the server-side tick
 * at +1 min). This spec proves the GESTURE: right-click menu -> «Rimanda a...»
 * -> date -> the card lands in backlog with the chip on its face, and
 * «Annulla il rimando» (cancel the snooze) brings it back without the chip. // allow-italian: quoted UI label
 * Two widths (375 and 1440) because the chip and the menu are the only
 * surface a human has to approve by eye.
 *
 * @covers KANBAN-127
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, deleteTask, resetPaneStore, resetProjectPanes, seedProjectPane } from "./helpers/api-fixtures";
import { mkdirSync, writeFileSync } from "fs";
import { canonicalTmpDir, removeTmpDir } from "./helpers/file-project";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { projectIdForPath as boardIdForPath } from "../../shared/board";

hermetic(test);

const BASE = E2E_BASE;
const PROJECT_PATH = canonicalTmpDir(`e2e-cardsnooze-${process.pid}`);
const PROJECT_ID = boardIdForPath(PROJECT_PATH);

const CARD_TEXT = "Scrivere la newsletter di dicembre";

let projectTopicId: string | null = null;
const createdTasks: string[] = [];

async function createTask(request: any, text: string): Promise<{ id: string }> {
  const res = await request.post(`${BASE}/api/boards/${PROJECT_ID}/tasks`, { data: { text, status: "todo" } });
  expect(res.ok()).toBe(true);
  const task = (await res.json()) as { id: string };
  createdTasks.push(task.id);
  return task;
}

async function openProjectBoard(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /e2e-cardsnooze/);
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

test.describe("Rimanda a · menu della card", () => {
  test.describe.configure({ timeout: 60_000 });
  test.use({ viewport: { width: 1440, height: 900 } });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-cardsnooze" }, null, 2));
    const topic = await createTopic(request, "E2E-CardSnooze", { projectPath: PROJECT_PATH });
    projectTopicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    for (const id of [...createdTasks].reverse()) await deleteTask(request, PROJECT_ID, id);
    if (projectTopicId) await deleteTopic(request, projectTopicId);
    removeTmpDir(PROJECT_PATH);
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, PROJECT_PATH);
    await seedProjectPane(page.request, PROJECT_PATH);
  });

  test("rimanda la card a una data: backlog con chip, poi annulla", async ({ page, request }) => {
    const card = await createTask(request, CARD_TEXT);

    await page.goto("/");
    await openProjectBoard(page);

    const todo = page.getByTestId("kanban-column-todo");
    const cardLocator = page.locator(`[data-task-card="${card.id}"]`);

    await expect(todo.locator(`[data-task-card="${card.id}"]`)).toBeVisible({ timeout: 10000 });

    // ── 1. Right-click -> «Rimanda a...» ──────────────────────────────────
    await cardLocator.click({ button: "right" });
    const snoozeMenuItem = page.getByRole("menuitem", { name: "Rimanda a…" });
    await expect(snoozeMenuItem).toBeVisible({ timeout: 5000 });
    await page.screenshot({ path: "test-results/evidence/card-snooze-menu-1440.png" });
    await snoozeMenuItem.click();

    const promptInput = page.locator('input[id^="snooze-"]');
    await expect(promptInput).toBeVisible({ timeout: 5000 });
    const future = new Date(Date.now() + 24 * 3600 * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const value = `${future.getFullYear()}-${pad(future.getMonth() + 1)}-${pad(future.getDate())}T09:00`;
    await promptInput.fill(value);
    await page.getByRole("button", { name: "Rimanda a…" }).click();

    // ── 2. The card leaves Todo and lands in Backlog with the date chip ────
    await expect(todo.locator(`[data-task-card="${card.id}"]`)).toHaveCount(0, { timeout: 10000 });
    const backlog = page.getByTestId("kanban-column-backlog");
    const backlogCard = backlog.locator(`[data-task-card="${card.id}"]`);
    await expect(backlogCard).toBeVisible({ timeout: 10000 });
    await expect(backlogCard.getByTestId("card-wake-at")).toBeVisible();

    // The proof at 375px: the chip stays readable at the board's minimum width.
    await page.setViewportSize({ width: 375, height: 800 });
    await expect(backlogCard.getByTestId("card-wake-at")).toBeVisible({ timeout: 10000 });
    await page.screenshot({ path: "test-results/evidence/card-snooze-chip-375.png" });
    await page.setViewportSize({ width: 1440, height: 900 });

    // ── 3. «Annulla il rimando» drops the chip, the card stays in backlog ── // allow-italian: quoted UI label
    await backlogCard.click({ button: "right" });
    const cancelMenuItem = page.getByRole("menuitem", { name: "Annulla il rimando" });
    await expect(cancelMenuItem).toBeVisible({ timeout: 5000 });
    await cancelMenuItem.click();
    await expect(backlogCard.getByTestId("card-wake-at")).toHaveCount(0, { timeout: 10000 });
  });
});
