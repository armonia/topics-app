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
import { projectRow } from "./helpers/project-row";
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
  const btn = projectRow(page, /e2e-toolbar-overflow/);
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

    test.info().annotations.push({ type: "spec", description: "KANBAN-47" });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");
    await openProjectBoard(page);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(150);

    const metrics = await toolbarMetrics(page);
    const affordance = page.getByTestId("toolbar-overflow-affordance");

    // L'eccedenza è la PREMESSA di questo test, e la fixture è nostra
    // (`seedProjectPane` qui sopra): quindi si asserisce, non si salta. Prima
    // qui c'era `test.skip(true, "…nothing to assert")` — se un giorno la
    // toolbar smettesse di eccedere a 390px (pulsanti tolti, larghezze
    // cambiate, seeding diverso) il test sarebbe diventato verde-vuoto invece
    // che rosso, e l'affordance di scroll non sarebbe più stata verificata da
    // nessuno. Se questa riga fallisce, la risposta giusta è guardare: o è
    // cambiato il prodotto, o è derivata la fixture.
    expect(
      metrics.scrollWidth - metrics.clientWidth,
      "a 390px la toolbar deve eccedere il viewport, altrimenti non c'è nessuna affordance da verificare",
    ).toBeGreaterThan(1);

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

  // Regression: the column scroll body showed TWO overlapping scrollbars on
  // hover — the app's standard thin bar AND the legacy ::-webkit-scrollbar,
  // both drawn by dual-render engines (macOS "show while scrolling").
  // `scrollbar-standard` keeps the standard bar as the single indicator and
  // zeroes the webkit one. Measured on the DOM, not by eye:
  //   - scrollbar-width stays `thin` (an indicator survives — NOT `none`, which
  //     would leave the column with no scroll cue at all).
  //   - the ::-webkit-scrollbar computed width is 0 (no second bar).
  test("COLUMN-SCROLLBAR-01: la colonna tiene UNA sola barra (standard thin, webkit azzerata)", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");
    await openProjectBoard(page);

    const body = page.getByTestId("kanban-board").locator('[data-testid^="kanban-column-body-"]').first();
    await expect(body).toBeVisible({ timeout: 10000 });
    const m = await body.evaluate((el) => ({
      width: getComputedStyle(el).scrollbarWidth,
      webkit: getComputedStyle(el, "::-webkit-scrollbar").width,
    }));
    expect(m.width, "l'indicatore standard deve sopravvivere (non 'none')").toBe("thin");
    expect(m.webkit, "la barra webkit legacy deve essere azzerata").toBe("0px");
  });
});
