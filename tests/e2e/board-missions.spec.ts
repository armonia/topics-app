/**
 * board-missions.spec.ts, acceptance for MISSIONS: the board's side session.
 *
 * Verdict on the previous shape (merge 5f39a2c1), looked at live: the
 * orchestrator was a chip INSIDE the board composer, which is the one place
 * every card is born from, and it existed in a user install too. The good
 * shape is the opposite: one command that hands a preset job to a NORMAL
 * project chat next to the kanban, and that does not exist outside a
 * development install.
 *
 * This spec measures those two sentences instead of describing them:
 *  1. in a development install the command is there, and a mission lands in the
 *     composer of a project chat WITH its finishing bar inside the text, since
 *     that line is what separates a mission from a prompt;
 *  2. outside development it is neither hidden nor disabled: it is not in the DOM.
 *
 * The gate is `server.devReload` (the `topics-dev.json` flag in STATE_DIR) read
 * from `/api/system/status`. Here the REAL response is fetched and only that one
 * field is rewritten, so the rest of the status bar keeps receiving what it
 * receives in production.
 */
import { test } from "./fixtures/layout.fixture";
import { projectRow } from "./helpers/project-row";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane } from "./helpers/api-fixtures";
import { mkdirSync, writeFileSync } from "fs";
import { hermetic } from "./fixtures/hermetic";
import { canonicalTmpDir, removeTmpDir } from "./helpers/file-project";

hermetic(test);

const PROJECT_PATH = canonicalTmpDir("e2e-missions");
const TOPIC_NAME = "E2E-Missions";

let projectTopicId: string | null = null;

/** The real `/api/system/status` response with the dev flag rewritten. */
async function withDevInstall(page: Page, dev: boolean) {
  await page.route("**/api/system/status", async (route) => {
    const res = await route.fetch();
    let body: Record<string, unknown> = {};
    try { body = await res.json(); } catch { body = {}; }
    const server = (body.server ?? {}) as Record<string, unknown>;
    await route.fulfill({
      response: res,
      json: { ...body, server: { ...server, devReload: dev } },
    });
  });
}

async function openProjectBoard(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti|Projects section/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = projectRow(page, /e2e-missions/);
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

test.describe("Board: missions to the side session", () => {
  test.describe.configure({ timeout: 90_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-missions" }, null, 2));
    const topic = await createTopic(request, TOPIC_NAME, { projectPath: PROJECT_PATH });
    projectTopicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    if (projectTopicId) await deleteTopic(request, projectTopicId);
    removeTmpDir(PROJECT_PATH);
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, PROJECT_PATH);
    await seedProjectPane(page.request, PROJECT_PATH);
  });

  test("MISSIONS-01: a mission lands in the project chat composer, bar included", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-100" });
    await page.setViewportSize({ width: 1280, height: 900 });
    await withDevInstall(page, true);
    await page.goto("/");
    await openProjectBoard(page);

    const missions = page.getByTestId("missions-button");
    await expect(missions, "in a development install the command is there").toBeVisible({ timeout: 10000 });
    await missions.click();

    // The bar is readable BEFORE choosing: that line is what makes a menu entry
    // a mission instead of a prompt with a nice name.
    const inboxZero = page.getByTestId("mission-inbox-zero");
    await expect(inboxZero).toBeVisible();
    // allow-italian: the shipped UI string of the done-when line.
    await expect(inboxZero).toContainText(/finita quando:|done when:/);
    await inboxZero.click();

    // The side session is a NORMAL project chat, opened next to the board, with
    // the mission text in front of it and NOT sent.
    const composer = page.getByRole("textbox", {
      name: new RegExp(`(Campo del messaggio per|Message input for) ${TOPIC_NAME}$`),
    });
    await expect(composer, "the project chat opens next to the board").toBeVisible({ timeout: 15000 });
    // allow-italian: the mission text handed to the session is Italian by design.
    await expect(composer).toHaveValue(/MISSIONE . inbox 0/);
    await expect(composer, "the bar travels inside the text, not only in the menu")
      // allow-italian: same shipped mission text.
      .toHaveValue(/COME SI SA CHE . FINITA/);
    await expect(page.getByTestId("kanban-board"), "the board stays: the session is NEXT TO it, not instead of it").toBeVisible();
  });

  test("MISSIONS-02: outside a development install the command is not in the DOM", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "KANBAN-101" });
    await page.setViewportSize({ width: 1280, height: 900 });
    await withDevInstall(page, false);
    await page.goto("/");
    await openProjectBoard(page);

    // Not `toBeHidden`: hidden means rendered. This internal surface must not be
    // there at all.
    await expect(page.getByTestId("missions-button")).toHaveCount(0);
    // ...and the rest of the board chrome is intact, so the count above is not
    // vacuous.
    await expect(page.locator('[data-testid^="kanban-column-body-"]').first()).toBeVisible({ timeout: 10000 });
  });
});
