/**
 * board-layout-toggle.spec.ts — the list view is an alternative to kanban,
 * not a second panel.
 *
 * The toggle next to search does not open anything: it REWRITES the board.
 * In kanban view the columns sit side by side, each its own carousel lane;
 * in list view they stack vertically at full width, and a column with no
 * card and no draft in flight does not even draw its header — that is the
 * defect the list view exists to fix (in kanban view that same empty column
 * stays a visible drop target).
 *
 * One task, in one column: with a card in every status "the list hides the
 * empty ones" would be indistinguishable from "the list shows everything".
 * Here four columns out of five ARE empty, so their absence is the signal,
 * not the noise.
 *
 * Reloading the page is the proof the choice persists: an `aria-pressed`
 * that reverts to "false" after an F5 would be component state, not a
 * preference of whoever is looking at the board.
 *
 * @covers KANBAN-94
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
const PROJECT_PATH = canonicalTmpDir(`e2e-layouttoggle-${process.pid}`);
const PROJECT_ID = boardIdForPath(PROJECT_PATH);

const SOLA_CARD = "Scrivere il changelog";

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
  const btn = projectRow(page, /e2e-layouttoggle/);
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

test.describe("Vista lista della board · toggle, forma, persistenza", () => {
  test.describe.configure({ timeout: 90_000 });
  test.use({ viewport: { width: 1120, height: 620 } });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-layouttoggle" }, null, 2));
    const topic = await createTopic(request, "E2E-LayoutToggle", { projectPath: PROJECT_PATH });
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

  test("il tasto alterna kanban e lista, le colonne vuote spariscono solo in lista, e la scelta sopravvive al reload", async ({ page, request }) => {
    const task = await createTask(request, SOLA_CARD);

    await page.goto("/");
    await openProjectBoard(page);

    const toggle = page.getByTestId("board-layout-toggle");
    const todoCol = page.getByTestId("kanban-column-todo");
    const backlogCol = page.getByTestId("kanban-column-backlog");
    const card = page.locator(`[data-task-card="${task.id}"]`);

    // ── 1. Kanban by default: every column is there, even the empty ones ────
    await expect(todoCol).toBeVisible({ timeout: 10000 });
    await expect(backlogCol).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");

    // ── 2. One click: the board becomes a list, empty columns vanish ────────
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(backlogCol).toHaveCount(0, { timeout: 10000 });
    await expect(todoCol).toBeVisible();
    await expect(todoCol.locator(`[data-task-card="${task.id}"]`)).toContainText(SOLA_CARD);

    // ── 3. Reload: list view was not just component state ───────────────────
    await page.reload();
    await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 10000 });
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(backlogCol).toHaveCount(0, { timeout: 10000 });
    await expect(todoCol).toBeVisible();

    // ── 4. Back to kanban: the empty columns reappear ────────────────────────
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(backlogCol).toBeVisible({ timeout: 10000 });
    await expect(card).toBeVisible();
  });
});
