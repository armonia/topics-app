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
 *  - GAUGE-02  4 on 4: a full ring, "pieno", tone full. allow-italian: quotes the UI word the gauge shows
 *  - GAUGE-03  5 on 4: the ring stays full (it cannot overflow) and the tone
 *    is what says "past it": "oltre il limite", tone over.
 *  - GAUGE-04  the popover leads with ONE number, "il Mac è occupato al 44%", allow-italian: quotes the UI sentence
 *    coloured, and no technical word (core, CPU, memory, GB, load) outside the
 *    folded "Dettagli"; the mode and how the machine derived the ceiling
 *    ("12 core → 4") are inside it, and "Impostazioni" opens the settings. allow-italian: quotes the button label
 *  - GAUGE-05  the settings panel shows the SAME reading beside the live count:
 *    ring and word with the same tone and fill as the header, the count said
 *    once on the running line. Two surfaces built from one store cannot
 *    disagree; this is where it is checked.
 *  - GAUGE-06  on the budget brake the ring fills with USE OVER WHAT IS USABLE
 *    (it used to stay empty in that mode, which is a gauge saying nothing in
 *    the mode whose whole question is "how full is it"); the popover says how
 *    busy the Mac is in one amber percentage, and Topics' share in % under
 *    "Dettagli".
 *  - GAUGE-07  memory holds the queue while the CPU is inside the budget: the
 *    ring is full, the word says the Mac is busy, and the wait sentence says
 *    it in the same percentage with the point where it restarts by itself.
 *  - GAUGE-08  nothing measured: "non misurabile", never an invented 0%.
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
/** Where the before/after proof of the one-number popover goes, outside the repo. */
const PROOF = process.env.LOAD_PCT_SHOTS ?? "";

/**
 * The words a person who is not technical should never meet in the main text.
 * `details` is removed first: the technical numbers are allowed only behind
 * the folded "Dettagli", which is the whole point of the change.
 */
const TECH_WORDS = /\b(core|core-unit\w*|CPU|memoria|memory|RAM|GB|load)\b/i;
async function mainText(el: import("@playwright/test").Locator): Promise<string> {
  return el.evaluate((node) => {
    const clone = node.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("details, [data-technical]").forEach((d) => d.remove());
    return clone.textContent ?? "";
  });
}
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

  test("GAUGE-04: il popover dice UN numero, «il Mac è occupato al 44%», e i dettagli tecnici restano chiusi", async ({ page }) => {
    await stubMachine(page, 2);
    await page.goto("/");
    await openBoard(page);
    await expect(word(page)).toHaveText("leggero");

    const popover = page.getByTestId("dispatch-load-popover");
    await expect(popover).toHaveCount(0);
    await gauge(page).click();
    await expect(popover).toBeVisible();
    await expect(popover).toContainText("Carico del dispatcher");
    // THE ONE NUMBER, the larger of CPU and memory, green under 60.
    const busy = popover.getByTestId("machine-busy-pct");
    await expect(busy).toHaveText("Il Mac è occupato al 44%");
    await expect(busy).toHaveAttribute("data-tone", "ok");
    await expect(popover).toContainText("2 agent al lavoro, massimo 4");
    expect(await mainText(popover)).not.toMatch(TECH_WORDS);
    if (PROOF) await popover.screenshot({ path: join(PROOF, "popover.png") });
    // The technical reading is still there, one click away.
    const details = popover.getByTestId("dispatch-load-details");
    await expect(details.getByTestId("dispatch-load-derivation")).toBeHidden();
    await details.locator("summary").click();
    await expect(popover).toContainText("Tetto automatico");
    await expect(details.getByTestId("dispatch-load-derivation")).toContainText("12 core → 4");
    await expect(details).toContainText("CPU 41%");
    await expect(details).toContainText("memoria 44%");
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
    const menu = page.getByTestId("board-settings-menu");
    const summary = menu.getByTestId("dispatch-load-summary");
    await expect(summary).toBeVisible();
    // The count is said once, on the running line the ring sits beside.
    await expect(menu.getByTestId("global-cap-running")).toContainText("2 di 4");
    await expect(summary).toHaveText("leggero");
    await expect(summary).toHaveAttribute("data-tone", "idle");
    await expect(summary).toHaveAttribute("data-fill", "0.50");
  });

  test("GAUGE-06: a budget, l'anello si riempie sul budget e il popover dice il Mac in %", async ({ page }) => {
    // The machine of the card: Topics taking 4.8 core-units of a 7.2 budget on
    // twelve cores, that is 40% of the PC against a 60% budget, and two check
    // runs frozen for load.
    await page.route((url) => url.pathname === "/api/system/dispatch-capacity", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          recommended: 4, cores: 12, totalMemGB: 32, availableMemGB: 18, load1: 9.1, running: 3,
          oursCores: 4.8, budgetCores: 6,
          // Usable is the share of the free, 60% of the 9 cores the others
          // leave: 5.4, not the 7.2 budget, so the ring and the popover are
          // seen to read the right one of the two.
          budgetShare: 0.6, budgetCoreUnits: 7.2, usableCoreUnits: 5.4,
          usedCoreUnits: 4.8, usedMemGB: 6, otherCoreUnits: 3, frozen: 2,
          machineCpuPct: 76, machineMemPct: 44,
          reason: "12 core, base 4",
        }),
      }));
    await page.goto("/");
    await openBoard(page);
    await gear(page).click();
    await page.getByTestId("global-cap-brake-resources").click();
    await page.keyboard.press("Escape");

    // The ring is not empty any more in this mode: it fills with use over
    // budget, 4.8 of 7.2 = two thirds.
    const g = gauge(page);
    await expect(word(page)).toHaveText("a budget");
    await expect(g).toHaveAttribute("data-fill", "0.89");
    await expect(g).toHaveAttribute("aria-label", /3 agent al lavoro, Topics usa il 40% del Mac/);

    await g.click();
    const popover = page.getByTestId("dispatch-load-popover");
    await expect(popover).toBeVisible();
    // 76% CPU beats 44% memory, and 76 is amber.
    await expect(popover.getByTestId("machine-busy-pct")).toHaveText("Il Mac è occupato al 76%");
    await expect(popover.getByTestId("machine-busy-pct")).toHaveAttribute("data-tone", "busy");
    expect(await mainText(popover)).not.toMatch(TECH_WORDS);
    await popover.getByTestId("dispatch-load-details").locator("summary").click();
    await expect(popover).toContainText("Quota: fino al 60% del Mac libero");
    // Topics' own share, in % of the Mac: 4.8 of 12 = 40, ceiling 5.4 of 12 = 45.
    await expect(popover.getByTestId("dispatch-load-budget")).toHaveText("Topics usa il 40% del Mac, può arrivare al 45%");
    await expect(popover).toContainText("2 check congelati per carico");
    await expect(popover).not.toContainText("del PC");
    await page.screenshot({ path: join(SHOTS, "06-a-budget.png"), clip: { x: 0, y: 0, width: 1600, height: 500 } });

    // THE BRAKE IS PER MACHINE AND IT PERSISTS: left on "resources", the next
    // scenario in this file would read a budget where it expects a count, and
    // the failure would land on THAT test instead of this one. Measured here:
    // GAUGE-05 went red once and green on the retry, because the retry resets
    // the server.
    await page.keyboard.press("Escape");
    await gear(page).click();
    await page.getByTestId("global-cap-brake-count").click();
    await expect(page.getByTestId("global-cap-mode-auto")).toBeVisible();
  });

  test("GAUGE-07: la memoria trattiene la coda: anello pieno, «aspetta: Mac occupato», e la frase dice da dove riparte", async ({ page }) => {
    // The night's shape: our CPU well inside the budget, memory holding the
    // queue. The ring used to fill with the CPU (61%) and say "a budget".
    await page.route((url) => url.pathname === "/api/system/dispatch-capacity", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          recommended: 4, cores: 12, totalMemGB: 34, availableMemGB: 7, load1: 6, running: 16,
          oursCores: 3, budgetCores: 5.5,
          budgetShare: 0.6, budgetCoreUnits: 7.2, usableCoreUnits: 6.6,
          usedCoreUnits: 4, usedMemGB: 22, otherCoreUnits: 1, frozen: 0,
          agentCostMemGB: 1.5, freeQuotaMemGB: 4.2,
          // 1 - 7/34 = 79% memory, 30% CPU: memory makes the number.
          machineCpuPct: 30, machineMemPct: 79,
          admission: {
            admit: false, blockedBy: "memory", firstAgentExempt: false, costCoreUnits: 0.5,
            usedCoreUnits: 4, usableCoreUnits: 6.6, pendingAdmissions: 0,
            costMemGB: 1.5, freeQuotaMemGB: 4.2, ourMemGB: 22, usableMemGB: 20.4, memClause: "footprint",
          },
          reason: "12 core, base 4",
        }),
      }));
    await page.goto("/");
    await openBoard(page);
    await gear(page).click();
    await page.getByTestId("global-cap-brake-resources").click();
    // Topics holds 22.0 GB over a 20.4 GB ceiling: 1.6 GB of 34 is 4.7 points
    // of the Mac, so the gate reopens once the Mac is under 79 - 4.7 = 74%.
    const WAIT = "In attesa: il Mac è occupato al 79%, parte da solo sotto il 74%";
    await expect(page.getByTestId("global-cap-verdict")).toHaveText(WAIT);
    await page.keyboard.press("Escape");

    const g = gauge(page);
    await expect(word(page)).toHaveText("aspetta: Mac occupato");
    await expect(g).toHaveAttribute("data-held", "memory");
    await expect(g).toHaveAttribute("data-fill", "1.00");

    await g.click();
    const popover = page.getByTestId("dispatch-load-popover");
    await expect(popover.getByTestId("dispatch-load-verdict")).toHaveText(WAIT);
    await expect(popover.getByTestId("machine-busy-pct")).toHaveAttribute("data-tone", "busy");
    expect(await mainText(popover)).not.toMatch(TECH_WORDS);
    await popover.getByTestId("dispatch-load-details").locator("summary").click();
    await expect(popover.getByTestId("dispatch-load-memory")).toHaveText("memoria: Topics tiene 22.0 GB, liberi per Topics 4.2 GB, un agent ne chiede 1.5");
    await page.screenshot({ path: join(SHOTS, "07-memoria.png"), clip: { x: 0, y: 0, width: 1600, height: 500 } });

    // Back to count, for the same reason as GAUGE-06.
    await page.keyboard.press("Escape");
    await gear(page).click();
    await page.getByTestId("global-cap-brake-count").click();
    await expect(page.getByTestId("global-cap-mode-auto")).toBeVisible();
  });

  test("GAUGE-08: niente misurato: «non misurabile», mai uno 0% inventato", async ({ page }) => {
    await page.route((url) => url.pathname === "/api/system/dispatch-capacity", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          recommended: 4, cores: 12, totalMemGB: 32, availableMemGB: null, load1: 3.2, running: 1,
          oursCores: 0.6, budgetCores: 6, budgetShare: 0.6, budgetCoreUnits: 7.2, usableCoreUnits: 7.2,
          usedCoreUnits: 0.6, usedMemGB: 1, otherCoreUnits: 1, frozen: 0,
          machineCpuPct: null, machineMemPct: null,
          reason: "12 core, base 4",
        }),
      }));
    await page.goto("/");
    await openBoard(page);
    await gauge(page).click();
    const busy = page.getByTestId("dispatch-load-popover").getByTestId("machine-busy-pct");
    await expect(busy).toHaveText("Occupazione del Mac non misurabile");
    await expect(busy).toHaveAttribute("data-tone", "unknown");
    await expect(busy).not.toContainText("%");
  });
});
