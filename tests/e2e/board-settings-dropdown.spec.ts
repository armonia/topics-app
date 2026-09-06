/**
 * board-settings-dropdown.spec.ts - the board settings are ONE dropdown on the
 * gear, and the cap inside it knows two brakes.
 *
 * WHAT IS MEASURED, and why it is geometry and not a screenshot:
 *
 *  - DROP-01  the gear opens a panel ANCHORED to the gear: right edge on the
 *    gear's right edge, top under the gear's bottom, narrower than half the
 *    board. A band under the toolbar would be as wide as the board and would
 *    push the columns down: the column's `y` is read before and after, and it
 *    must not move. The panel is portalled to <body>: none of it lives inside
 *    the board's subtree.
 *  - DROP-02  Escape closes it and the focus is back on the gear; a click
 *    outside closes it too. These are the `Menu` contract, and the point of
 *    using the primitive is that they come for free - so they are asserted,
 *    or "for free" is a hope.
 *  - DROP-03  a Select INSIDE the dropdown (the board language) opens, closes
 *    on Escape and on a pick, and the dropdown STAYS. Before the descendant
 *    rule in `useDismissable` the parent closed under the child's first click
 *    and the option could never be chosen.
 *  - DROP-04  "by resources": the two sliders with their coloured band and the
 *    band said in words, the live reading coloured against the threshold, the
 *    verdict line, and NO fixed-number box. A slider move writes the threshold
 *    once, in the wire name.
 *  - DROP-05  the choice survives a reload: the mode and the threshold come
 *    back from `GET /api/all-boards/settings`.
 *  - DROP-06  on a short window the panel caps itself inside the viewport and
 *    scrolls within: the last section is reachable and the page never grows.
 *
 * THE SETTINGS ROUTE IS STUBBED IN DROP-04 ONLY, to record what goes on the
 * wire when a slider moves: the subject there is the client's half of the
 * contract, one write per move, in the wire names. DROP-05 deliberately does
 * NOT stub it. Persistence is a property of the real row, and a scenario that
 * reloads against an in-memory answer proves only that the client re-reads
 * what the test itself invented.
 *
 * The system probes are stubbed the way `board-topbar-legibility.spec.ts` does
 * it: a load of 15.4 on 12 cores and 9.5 GB free of 32 is a machine over the
 * default load threshold and under the memory one, which is exactly the state
 * that tells the verdict line's two axes apart.
 *
 * @covers KANBAN-75, KANBAN-12
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
const NAME = "capdrop";
const ROOT = `/tmp/e2e-${NAME}-${STAMP}`;
const DIR = `${ROOT}/${NAME}`;

const SHOTS = join(process.cwd(), "test-results", "settings-dropdown");
const topicIds: string[] = [];

/** The machine, stubbed: over the load threshold, under the memory one. */
async function stubMachine(page: Page) {
  await page.route((url) => url.pathname === "/api/system/dispatch-capacity", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        recommended: 2, cores: 12, totalMemGB: 32, availableMemGB: 9.5, load1: 15.4, running: 1,
        oursCores: 1.2, budgetCores: 6,
        reason: "12 core, base 4",
      }),
    }));
}

/**
 * A server that KNOWS the three fields, layered over the real one: PATCHes
 * carrying them are recorded and answered, everything else passes through.
 * Returns the recorded writes so the test can say what went on the wire.
 */
async function stubBrakeServer(page: Page) {
  const extras: Record<string, unknown> = {};
  const writes: Array<Record<string, unknown>> = [];
  // The last answer the real server gave: a PATCH that carries ONLY the three
  // fields has nothing the real server understands, so it is answered from
  // here instead of being turned into a GET (Playwright disposes the response
  // of a request whose method was rewritten, measured: "Response has been
  // disposed" on every such PATCH). The client always reads before it writes,
  // so the copy is there by the time a write comes.
  let last: Record<string, unknown> | null = null;
  await page.route((url) => url.pathname === "/api/all-boards/settings", async (route) => {
    const req = route.request();
    if (req.method() === "PATCH") {
      const body = JSON.parse(req.postData() ?? "{}") as Record<string, unknown>;
      writes.push(body);
      const rest: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(body)) {
        if (k === "maxAgentsMode" || k === "maxLoadRatio" || k === "maxMemRatio") extras[k] = v;
        else rest[k] = v;
      }
      if (Object.keys(rest).length > 0 || !last) {
        const res = await route.fetch(Object.keys(rest).length > 0 ? { postData: JSON.stringify(rest) } : {});
        last = (await res.json()) as Record<string, unknown>;
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...last, ...extras }) });
    }
    const res = await route.fetch();
    last = (await res.json()) as Record<string, unknown>;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...last, ...extras }) });
  });
  return writes;
}

/**
 * The project window may ALREADY hold a Board pane: the previous test's page
 * flushes its pane store on close, and that write can land after this test's
 * reset (measured on a bundle built from HEAD, so it predates this spec: the
 * `+` menu then has no "Board" entry and the helper gives up). A Board tab that
 * is already there is opened by clicking it, which is what a person would do.
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
const menu = (page: Page) => page.getByTestId("board-settings-menu");
const panel = (page: Page) => page.getByTestId("board-settings-panel");

test.describe("Impostazioni della board: un dropdown sul ⚙, due freni dentro", () => {
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
    await stubMachine(page);
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test("DROP-01: il ⚙ apre un pannello ancorato al ⚙, e le colonne non si muovono", async ({ page }) => {
    await page.goto("/");
    await openBoard(page);
    const board = page.getByTestId("kanban-board");
    const column = page.getByTestId("kanban-column-todo");
    const columnBefore = (await column.boundingBox())!;

    await expect(menu(page)).toHaveCount(0);
    await gear(page).click();
    await expect(menu(page)).toBeVisible();
    await expect(panel(page)).toBeVisible();

    // Anchored: right edge on the gear's right edge (within the clamp margin),
    // top just under the gear. Narrow: a dropdown, not a band.
    const g = (await gear(page).boundingBox())!;
    const m = (await menu(page).boundingBox())!;
    const b = (await board.boundingBox())!;
    expect(Math.abs(m.x + m.width - (g.x + g.width)), "il bordo destro del pannello non sta sul ⚙").toBeLessThanOrEqual(12);
    expect(m.y, "il pannello non sta sotto il ⚙").toBeGreaterThanOrEqual(g.y + g.height - 1);
    // A band was as wide as the board; a dropdown has a reading width of its
    // own (the shell caps it at 400px plus the surface's hairline).
    expect(m.width, "largo come una banda, non come un dropdown").toBeLessThanOrEqual(404);
    expect(b.width - m.width, "il pannello copre la barra da parte a parte").toBeGreaterThan(200);
    expect(m.height, "un dropdown senza tetto: piu' alto del viewport").toBeLessThanOrEqual(800 * 0.7 + 16);

    // Floating: the columns did not move, and the panel is not in the board's subtree.
    const columnAfter = (await column.boundingBox())!;
    expect(columnAfter.y).toBe(columnBefore.y);
    await expect(board.getByTestId("board-settings-panel")).toHaveCount(0);

    await page.screenshot({ path: join(SHOTS, "dropdown-aperto.png"), clip: { x: 0, y: 0, width: 1280, height: 700 } });

    // Scrollable body: the last section is reachable by scrolling the panel.
    await panel(page).evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(panel(page).getByText("Alla consegna", { exact: true })).toBeInViewport();
  });

  test("DROP-06: su una finestra bassa il pannello sta nel viewport e scorre dentro di se'", async ({ page }) => {
    // 1000x560: a laptop with the dock and a browser chrome. The band used to
    // grow the page; the dropdown must cap itself and scroll INSIDE, so the
    // last section is reachable without the page moving.
    await page.setViewportSize({ width: 1000, height: 560 });
    await page.goto("/");
    await openBoard(page);
    await gear(page).click();
    await expect(panel(page)).toBeVisible();
    const m = (await menu(page).boundingBox())!;
    expect(m.y + m.height, "il pannello esce dal fondo della finestra").toBeLessThanOrEqual(560);
    expect(m.y, "il pannello esce dall'alto").toBeGreaterThanOrEqual(0);
    const last = panel(page).getByText("Alla consegna", { exact: true });
    await expect(last).not.toBeInViewport();
    await panel(page).evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(last).toBeInViewport();
    await expect(page.getByTestId("board-deploy-command")).toBeInViewport();
  });

  test("DROP-02: Escape chiude e il fuoco torna al ⚙; un click fuori chiude", async ({ page }) => {
    await page.goto("/");
    await openBoard(page);
    await gear(page).click();
    await expect(menu(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu(page)).toHaveCount(0);
    await expect(gear(page)).toBeFocused();

    await gear(page).click();
    await expect(menu(page)).toBeVisible();
    await page.getByTestId("kanban-column-backlog").click({ position: { x: 20, y: 200 } });
    await expect(menu(page)).toHaveCount(0);
  });

  test("DROP-03: una tendina dentro il dropdown si apre e si chiude senza portarselo via", async ({ page }) => {
    await page.goto("/");
    await openBoard(page);
    await gear(page).click();
    const language = page.getByTestId("board-language");
    await expect(language).toBeVisible();

    // Escape on the child closes the CHILD only.
    await language.click();
    const options = page.getByRole("option");
    await expect(options.first()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(options).toHaveCount(0);
    await expect(panel(page)).toBeVisible();

    // Picking the already-selected option: the child closes, the parent stays,
    // and nothing is written (same value).
    await language.click();
    await expect(options.first()).toBeVisible();
    await page.getByRole("option", { selected: true }).click();
    await expect(options).toHaveCount(0);
    await expect(panel(page)).toBeVisible();
    await expect(language).toBeVisible();
  });

  test("DROP-04: per risorse: cursori con la fascia, misura viva, verdetto, e niente numero fisso", async ({ page }) => {
    const writes = await stubBrakeServer(page);
    await page.goto("/");
    await openBoard(page);
    await gear(page).click();

    const control = page.getByTestId("global-cap-control");
    await expect(control).toBeVisible();
    // Born "by count", with the number box.
    await expect(page.getByTestId("global-cap-brake-count")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("global-cap-mode-auto")).toBeVisible();

    await page.getByTestId("global-cap-brake-resources").click();
    await expect(page.getByTestId("global-cap-brake-resources")).toHaveAttribute("aria-checked", "true");
    await expect.poll(() => writes.some((w) => w.maxAgentsMode === "resources")).toBe(true);

    // The fixed number does not apply, so it is not there to be believed.
    await expect(page.getByTestId("global-cap-max")).toHaveCount(0);
    await expect(page.getByTestId("global-cap-mode-fixed")).toHaveCount(0);
    await expect(control.getByTestId("global-cap-running")).toContainText("freno sulle risorse");

    // Default thresholds in the recommended band, said in words.
    const load = page.getByTestId("global-cap-load-slider");
    const mem = page.getByTestId("global-cap-mem-slider");
    await expect(load).toHaveAttribute("data-band", "green");
    await expect(mem).toHaveAttribute("data-band", "green");
    await expect(page.getByTestId("global-cap-load-value")).toHaveText("0.90");
    await expect(page.getByTestId("global-cap-mem-value")).toHaveText("85%");
    await expect(page.getByTestId("global-cap-load-band")).toContainText("Fascia consigliata");

    // The live reading against the threshold: 15.4 / 12 = 1.28 over 0.9 (red),
    // 22.5 of 32 GB = 70% under 85% but past three quarters of it (amber).
    await expect(page.getByTestId("global-cap-load-live")).toHaveAttribute("data-band", "red");
    await expect(page.getByTestId("global-cap-load-live")).toContainText("1.28 per core");
    await expect(page.getByTestId("global-cap-mem-live")).toHaveAttribute("data-band", "amber");
    await expect(page.getByTestId("global-cap-mem-live")).toContainText("22.5 di 32 GB");

    // The verdict names the axis: with one agent running, a new one waits on load.
    const verdict = page.getByTestId("global-cap-verdict");
    await expect(verdict).toHaveAttribute("data-admit", "false");
    await expect(verdict).toContainText("carico sopra la soglia");
    await page.screenshot({ path: join(SHOTS, "per-risorse.png"), clip: { x: 0, y: 0, width: 1280, height: 700 } });

    // Moving the load threshold: the band follows from both sides, and ONE write
    // per move goes out in the wire name.
    await load.fill("0.3");
    await expect(load).toHaveAttribute("data-band", "red");
    await expect(page.getByTestId("global-cap-load-band")).toContainText("Troppo bassa");
    await expect.poll(() => writes.filter((w) => "maxLoadRatio" in w).map((w) => w.maxLoadRatio)).toEqual([0.3]);

    await load.fill("2.5");
    await expect(page.getByTestId("global-cap-load-band")).toContainText("Troppo alta");
    await expect(page.getByTestId("global-cap-load-value")).toHaveText("2.50");
    // 1.28 is now well under 2.5: the live reading turns green and a new agent would start.
    await expect(page.getByTestId("global-cap-load-live")).toHaveAttribute("data-band", "green");
    await expect(verdict).toHaveAttribute("data-admit", "true");
    await expect(verdict).toContainText("partirebbe");

    await mem.fill("0.65");
    await expect(page.getByTestId("global-cap-mem-band")).toContainText("Prudente");
    await expect.poll(() => writes.filter((w) => "maxMemRatio" in w).map((w) => w.maxMemRatio)).toEqual([0.65]);
  });

  test("DROP-05: la modalita' e la soglia scelte tornano dopo il ricarico", async ({ page }) => {
    // NO STUB HERE, and that is the whole point of this scenario: persistence
    // is what the real row does. Answered from memory, a reload would only
    // prove that the client re-reads what the test itself just made up. The
    // server side of KANBAN-75 lands with this one, so the '*' row understands
    // the three fields and the reload goes all the way to SQLite and back.
    await page.goto("/");
    await openBoard(page);
    await gear(page).click();
    await page.getByTestId("global-cap-brake-resources").click();
    const load = page.getByTestId("global-cap-load-slider");
    await expect(load).toBeVisible();
    await load.fill("1.1");
    await expect(page.getByTestId("global-cap-load-value")).toHaveText("1.10");

    await page.reload();
    await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15000 });
    await gear(page).click();
    await expect(page.getByTestId("global-cap-brake-resources")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("global-cap-load-value")).toHaveText("1.10");
    await expect(page.getByTestId("global-cap-max")).toHaveCount(0);

    // Back to "by count": the three states and the number are back.
    await page.getByTestId("global-cap-brake-count").click();
    await expect(page.getByTestId("global-cap-mode-auto")).toBeVisible();
    await expect(page.getByTestId("global-cap-load-slider")).toHaveCount(0);
  });
});
