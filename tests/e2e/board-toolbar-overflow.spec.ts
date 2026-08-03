/**
 * board-toolbar-overflow.spec.ts — Acceptance for the Kanban toolbar mobile
 * overflow affordance.
 *
 * Finding (audit mobile Kanban, 2026-07-20): the board header toolbar is a
 * horizontally-scrollable strip with a HIDDEN scrollbar
 * (KanbanBoardPane.tsx) — scrollWidth (439px) exceeds clientWidth on every
 * mobile viewport tested (375–412px), but nothing signals it, so the extra
 * actions past the right edge are only discoverable by swiping blind.
 *
 * This spec is the acceptance criterion: at a 390px phone viewport it
 * measures the toolbar's own scrollWidth/clientWidth and asserts the fade +
 * chevron affordance is visible exactly when there is more to scroll, and
 * disappears once scrolled to the end. Desktop is asserted unchanged.
 */
import { test } from "./fixtures/layout.fixture";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane } from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const PROJECT_PATH = `/tmp/e2e-toolbar-overflow-${Date.now()}`;

let projectTopicId: string | null = null;

async function openTestProject(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = page
    .locator('[aria-label="Topics sidebar"] button')
    .filter({ hasText: /e2e-toolbar-overflow/ })
    .first();
  await expect(btn).toBeVisible({ timeout: 10000 });
  await btn.click();
  await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 10000 });
}

async function openProjectBoard(page: Page) {
  await openTestProject(page);
  const triggers = page.getByTestId("pane-add-menu-trigger");
  const count = await triggers.count();
  const item = page.getByTestId("pane-add-menu-kanban");
  let opened = false;
  for (let i = count - 1; i >= 0; i--) {
    const t = triggers.nth(i);
    if (!(await t.isVisible().catch(() => false))) continue;
    const clicked = await t.click({ timeout: 3000 }).then(() => true, () => false);
    if (!clicked) continue;
    if (await item.waitFor({ state: "visible", timeout: 2000 }).then(() => true, () => false)) {
      opened = true;
      break;
    }
    await page.keyboard.press("Escape");
  }
  if (!opened) throw new Error("no + menu with a Board (kanban) entry found");
  await item.click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 10000 });
}

async function toolbarMetrics(page: Page) {
  const toolbar = page.getByTestId("kanban-board").locator("div.overflow-x-auto").first();
  return toolbar.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    scrollLeft: el.scrollLeft,
  }));
}

test.describe("Kanban board toolbar — mobile overflow affordance", () => {
  test.describe.configure({ timeout: 60_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-toolbar-overflow" }, null, 2));
    const topic = await createTopic(request, "E2E-ToolbarOverflow", { projectPath: PROJECT_PATH });
    projectTopicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    if (projectTopicId) await deleteTopic(request, projectTopicId);
    rmSync(PROJECT_PATH, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, PROJECT_PATH);
    await seedProjectPane(page.request, PROJECT_PATH);
  });

  test("TOOLBAR-OVERFLOW-01: fade+chevron appears when scrollable and hides at scroll end (390px)", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");
    await openProjectBoard(page);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(150);

    const metrics = await toolbarMetrics(page);
    const affordance = page.getByTestId("toolbar-overflow-affordance");

    if (metrics.scrollWidth - metrics.clientWidth <= 1) {
      test.skip(true, "toolbar fits at 390px in this fixture — nothing to assert");
    }

    await expect(affordance, "l'affordance deve comparire quando la toolbar eccede il viewport").toBeVisible();

    const toolbar = page.getByTestId("kanban-board").locator("div.overflow-x-auto").first();
    await toolbar.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    await page.waitForTimeout(150);

    await expect(affordance, "l'affordance deve sparire a fine scroll").toBeHidden();
  });

  test("TOOLBAR-OVERFLOW-02: desktop never renders the affordance (1280px)", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");
    await openProjectBoard(page);

    const affordance = page.getByTestId("toolbar-overflow-affordance");
    if ((await affordance.count()) > 0) {
      await expect(affordance, "sm:hidden deve nascondere l'affordance su desktop anche se presente nel DOM").toBeHidden();
    }
  });

  // Regression: the column scroll body inherited the global `* { scrollbar-width:
  // thin }` (index.css) which paints a native macOS bar ON TOP of the app's
  // custom ::-webkit-scrollbar thumb — two overlapping bars on hover/scroll.
  // The `scrollbar-topbar` utility sets `scrollbar-width: none`, killing the
  // native one. Measured on the DOM (computed style), not by eye.
  test("COLUMN-SCROLLBAR-01: la colonna non espone la scrollbar nativa (scrollbar-width: none)", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");
    await openProjectBoard(page);

    const body = page.getByTestId("kanban-board").locator('[data-testid^="kanban-column-body-"]').first();
    await expect(body).toBeVisible({ timeout: 10000 });
    const scrollbarWidth = await body.evaluate((el) => getComputedStyle(el).scrollbarWidth);
    expect(scrollbarWidth, "la colonna deve sopprimere la barra nativa").toBe("none");
  });
});
