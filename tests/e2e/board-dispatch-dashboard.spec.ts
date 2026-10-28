/**
 * board-dispatch-dashboard.spec.ts - il pannello «Impostazioni auto-dispatch»
 * si apre sul cruscotto dei consumi: card al lavoro, card in coda con il testo
 * neutro del server, memoria del Mac e chi la tiene.
 *
 * DASH-01  hero «N al lavoro · M in coda», chi tiene la memoria, e il tetto
 *          (il resto del pannello) è ancora lì sotto.
 *
 * Lo screenshot va in `DASH_SHOTS` (default: test-results/) per il confronto
 * affiancato con il disegno.
 *
 * @covers KANBAN-79
 */
import { test } from "./fixtures/layout.fixture";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane } from "./helpers/api-fixtures";
import { projectRow } from "./helpers/project-row";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const STAMP = Date.now();
const NAME = "dispatchdash";
const ROOT = `/tmp/e2e-${NAME}-${STAMP}`;
const DIR = `${ROOT}/${NAME}`;

const SHOTS = process.env.DASH_SHOTS ?? join(process.cwd(), "test-results", "dispatch-dashboard");
const topicIds: string[] = [];
/** A 12-core machine at rest, with `running` agents in flight on a recommended 4. */
async function stubMachine(page: Page, running: number, recommended = 4) {
  await page.route((url) => url.pathname === "/api/system/dispatch-capacity", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        recommended, cores: 12, totalMemGB: 32, availableMemGB: 18, load1: 3.2, running,
        // The whole Mac: 41% CPU, 44% memory (1 - 18/32). The one number is 44.
        machineCpuPct: 41, machineMemPct: 44,
        oursCores: running * 0.6, budgetCores: 6,
        // The budget half of the reading: 60% of twelve cores, and our tree
        // taking 0.6 core-units per agent in flight.
        budgetShare: 0.6, budgetCoreUnits: 7.2, usableCoreUnits: 7.2,
        usedCoreUnits: running * 0.6, usedMemGB: 4, otherCoreUnits: 1, frozen: 0,
        reason: "12 core, base 4",
      }),
    }));
}

/**
 * The project window may ALREADY hold a Board pane: the previous test's page
 * flushes its pane store on close, and that write can land after this test's
 * reset. A Board tab that is already there is opened by clicking it, which is
 * what a person would do.
 */
async function boardAlreadyThere(page: Page): Promise<boolean> {
  if (await page.getByTestId("kanban-board").isVisible().catch(() => false)) return true;
  const tab = page.getByTestId("project-window").locator('[data-testid="pane-tab-label"]', { hasText: /^Board$/ });
  if ((await tab.count()) === 0) return false;
  await tab.first().click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15000 });
  return true;
}

async function openBoard(page: Page) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0 && (await projectsSection.getAttribute("aria-expanded")) === "false") {
    await projectsSection.click();
  }
  const row = projectRow(page, NAME);
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.click();
  await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 15000 });
  if (await boardAlreadyThere(page)) return;
  const triggers = page.getByTestId("pane-add-menu-trigger");
  const item = page.getByTestId("pane-add-menu-kanban");
  const count = await triggers.count();
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
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15000 });
}

const gear = (page: Page) => page.getByTestId("kanban-board").getByTitle("Impostazioni auto-dispatch");

async function stubQueue(page: Page) {
  await page.route((url) => url.pathname === "/api/dispatch/memory-queue", (route) =>
    route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({
        reading: { freeGB: 2.8, at: null }, threshold: { startGB: 3.5 },
        queue: [], running: [],
        consumers: [
          { label: "App aperte", gb: 10.3 }, { label: "macOS", gb: 6.6 },
          { label: "Strumenti di sviluppo", gb: 5.8 }, { label: "Jarvis e altre sessioni di Claude", gb: 5.6 },
          { label: "Le 2 card al lavoro", gb: 0.9 },
        ],
        history: [],
      }),
    }));
}

test.describe("Il pannello auto-dispatch è un cruscotto dei consumi", () => {
  test.describe.configure({ timeout: 90_000 });
  test.beforeAll(async ({ request }) => {
    mkdirSync(SHOTS, { recursive: true });
    mkdirSync(DIR, { recursive: true });
    writeFileSync(`${DIR}/package.json`, JSON.stringify({ name: NAME }, null, 2));
    const topic = await createTopic(request, `${NAME}-${STAMP}`, { projectPath: DIR });
    topicIds.push(topic.id);
  });

  test.afterAll(async ({ request }) => {
    for (const id of topicIds) await deleteTopic(request, id).catch(() => {});
    rmSync(ROOT, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, DIR);
    await seedProjectPane(page.request, DIR);
    await page.setViewportSize({ width: 1600, height: 800 });
  });

  test("DASH-01: hero, chi tiene la memoria, il tetto resta", async ({ page }) => {
    await stubMachine(page, 2);
    await stubQueue(page);
    await page.goto("/");
    await openBoard(page);
    await gear(page).click();
    const menu = page.getByTestId("board-settings-menu");
    const dash = menu.getByTestId("dispatch-dashboard");
    await expect(dash).toBeVisible();
    await expect(dash.getByTestId("dispatch-dashboard-hero")).toHaveText("2 al lavoro · 0 in coda");
    await expect(dash.getByTestId("dispatch-dashboard-holders")).toContainText("10,3 GB");
    await expect(dash.getByTestId("dispatch-dashboard-queue-empty")).toBeVisible();
    await expect(menu.getByTestId("global-cap-running")).toBeVisible();
    await menu.screenshot({ path: join(SHOTS, "pannello.png") });
  });
});
