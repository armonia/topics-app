/**
 * board-dispatch-load-gauge.spec.ts - the dispatcher load is READ in the "In
 * progress" header, always, not only once it is already a problem.
 *
 * WHAT IS MEASURED. The gauge is a ring plus ONE word beside the column count.
 * The ring's fill and tone are exposed on the button as `data-fill` and
 * `data-tone` (the SVG arc is drawn from the same reading, so the attribute is
 * the cheaper truth of the two), the word is its own node, and the whole
 * sentence is the accessible name of a `role="meter"`. Three machines are served
 * through `page.route` on the capacity probe, and each one must produce exactly
 * one reading:
 *
 *  - GAUGE-01  2 running on a recommended 4: half a ring, "leggero", tone idle.
 *  - GAUGE-02  4 on 4: a full ring, "pieno", tone full.
 *  - GAUGE-03  5 on 4: the ring stays full (it cannot overflow) and the tone
 *    is what says "past it": "oltre il limite", tone over.
 *  - GAUGE-04  the numbers live one click away: the popover names the cap mode,
 *    says how the machine derived the ceiling ("12 core → 4", only because the
 *    cap is in auto), counts the agents in flight, and its "Impostazioni"
 *    button opens the board settings dropdown.
 *  - GAUGE-05  the settings panel shows the SAME reading under the cap knobs:
 *    "{running} di {limit}" with the same tone and fill as the header. Two
 *    surfaces built from one store cannot disagree; this is where it is checked.
 *
 * The cap is left in its default (by count, auto): the derivation line only
 * exists when the machine is what produced the limit, and auto is what the
 * fresh settings row says (asserted in GAUGE-04 before reading the line, so a
 * changed default is named instead of showing up as a missing node).
 *
 * The header of each state is also screenshotted at 3x, for the board card's
 * preview: the files are the proof that the three words are readable at badge
 * size, which no attribute can say.
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
const NAME = "loadgauge";
const ROOT = `/tmp/e2e-${NAME}-${STAMP}`;
const DIR = `${ROOT}/${NAME}`;

const SHOTS = join(process.cwd(), "test-results", "dispatch-load-gauge");
const topicIds: string[] = [];

/** A 12-core machine at rest, with `running` agents in flight on a recommended 4. */
async function stubMachine(page: Page, running: number, recommended = 4) {
  await page.route((url) => url.pathname === "/api/system/dispatch-capacity", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        recommended, cores: 12, totalMemGB: 32, availableMemGB: 18, load1: 3.2, running,
        oursCores: running * 0.6, budgetCores: 6,
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

const column = (page: Page) => page.getByTestId("kanban-column-in_progress");
/** The header row of "In progress": icon, label, gauge and count. */
const header = (page: Page) => column(page).locator(":scope > div").first();
const gauge = (page: Page) => column(page).getByTestId("dispatch-load-gauge");
const word = (page: Page) => gauge(page).getByTestId("dispatch-load-word");
const gear = (page: Page) => page.getByTestId("kanban-board").getByTitle("Impostazioni auto-dispatch");

/**
 * The header, for the preview. It must be WHOLLY in the viewport first: the
 * board scrolls sideways, and a column whose right end is past the edge comes
 * out with a grey box where the word should be (measured at 1280px).
 */
async function shoot(page: Page, file: string) {
  await expect(header(page)).toBeInViewport({ ratio: 1 });
  await header(page).screenshot({ path: join(SHOTS, file) });
}

/** The whole reading on the button: word, ring, tone, and the meter semantics. */
async function expectReading(page: Page, o: { running: number; limit: number; word: string; fill: string; tone: string }) {
  const g = gauge(page);
  await expect(word(page)).toHaveText(o.word);
  await expect(g).toHaveAttribute("data-tone", o.tone);
  await expect(g).toHaveAttribute("data-fill", o.fill);
  await expect(g).toHaveAttribute("role", "meter");
  await expect(g).toHaveAttribute("aria-valuenow", String(o.running));
  await expect(g).toHaveAttribute("aria-valuemax", String(o.limit));
  await expect(g).toHaveAttribute(
    "aria-label",
    `Carico del dispatcher: ${o.running} di ${o.limit} agent al lavoro. Apri per i numeri.`,
  );
}

test.describe("Il carico del dispatcher si legge nell'header di In progress", () => {
  test.describe.configure({ timeout: 90_000 });
  // 3x: the header is screenshotted for the preview, and a 10px word at 1x is
  // not a proof of anything.
  test.use({ deviceScaleFactor: 3 });

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

  test("GAUGE-01: 2 su 4: mezzo anello, «leggero», tinta neutra", async ({ page }) => {
    await stubMachine(page, 2);
    await page.goto("/");
    await openBoard(page);
    await expectReading(page, { running: 2, limit: 4, word: "leggero", fill: "0.50", tone: "idle" });
    await shoot(page, "01-leggero.png");
    // The count is still there: the gauge sits beside it, never instead of it.
    await expect(column(page).getByTestId("kanban-column-count-in_progress")).toHaveText("0");
  });

  test("GAUGE-02: 4 su 4: anello pieno, «pieno», tinta ambra", async ({ page }) => {
    await stubMachine(page, 4);
    await page.goto("/");
    await openBoard(page);
    await expectReading(page, { running: 4, limit: 4, word: "pieno", fill: "1.00", tone: "full" });
    await shoot(page, "02-pieno.png");
    await expect(gauge(page)).toHaveClass(/text-amber-300/);
  });

  test("GAUGE-03: 5 su 4: l'anello resta pieno, cambia la tinta, «oltre il limite»", async ({ page }) => {
    await stubMachine(page, 5);
    await page.goto("/");
    await openBoard(page);
    await expectReading(page, { running: 5, limit: 4, word: "oltre il limite", fill: "1.00", tone: "over" });
    await shoot(page, "03-oltre.png");
    await expect(gauge(page)).toHaveClass(/text-rose-300/);
  });

  test("GAUGE-04: i numeri sono nel popover, con «12 core → 4» e la porta alle impostazioni", async ({ page }) => {
    await stubMachine(page, 2);
    await page.goto("/");
    await openBoard(page);
    await expect(word(page)).toHaveText("leggero");

    const popover = page.getByTestId("dispatch-load-popover");
    await expect(popover).toHaveCount(0);
    await gauge(page).click();
    await expect(popover).toBeVisible();
    await expect(popover).toContainText("Carico del dispatcher");
    await expect(popover).toContainText("Tetto automatico");
    await expect(popover.getByTestId("dispatch-load-derivation")).toContainText("12 core → 4");
    await expect(popover).toContainText("2 agent in volo");
    await expect(popover).toContainText("load macchina 3.2 su 12 core");
    await expect(popover).toContainText("18 GB liberi su 32");
    await page.screenshot({ path: join(SHOTS, "04-popover.png"), clip: { x: 0, y: 0, width: 1600, height: 500 } });

    // The door to the knob: the popover closes, the settings dropdown opens,
    // and the cap it shows is the auto one the derivation line was read against.
    await popover.getByTestId("dispatch-load-settings").click();
    await expect(popover).toHaveCount(0);
    await expect(page.getByTestId("board-settings-menu")).toBeVisible();
    await expect(page.getByTestId("global-cap-mode-auto")).toBeVisible();
  });

  test("GAUGE-05: il pannello delle impostazioni mostra la stessa lettura dell'header", async ({ page }) => {
    await stubMachine(page, 2);
    await page.goto("/");
    await openBoard(page);
    await expectReading(page, { running: 2, limit: 4, word: "leggero", fill: "0.50", tone: "idle" });

    await gear(page).click();
    const readout = page.getByTestId("board-settings-menu").getByTestId("dispatch-load-readout");
    await expect(readout).toBeVisible();
    await expect(readout.getByTestId("dispatch-load-readout-count")).toHaveText("2 di 4");
    await expect(readout).toContainText("leggero");
    const line = readout.locator("[data-tone]");
    await expect(line).toHaveAttribute("data-tone", "idle");
    await expect(line).toHaveAttribute("data-fill", "0.50");
    await expect(readout).toContainText("load macchina 3.2 su 12 core");
  });
});
