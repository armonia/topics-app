/**
 * board-dispatch-dashboard.spec.ts - the board settings panel
 * opens on the consumption dashboard: the first version (summary, memory, who
 * holds it, Auto-dispatch and cap) with the three design improvements on top.
 *
 * DISPATCHDASH-01  the first version stays; memory chart with threshold and card
 *          strip, live status row, numbered queue with project, age
 *          and Start anyway on the first card, which calls `start-anyway` for it.
 *
 * The screenshots go to `DASH_SHOTS` (default: test-results/) for the
 * side-by-side comparison with the first version.
 *
 * @covers KANBAN-79
 */
import { test } from "./fixtures/layout.fixture";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane } from "./helpers/api-fixtures";
import { projectRow } from "./helpers/project-row";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { hermetic } from "./fixtures/hermetic";
import { apiCreateTask } from "./helpers/board-topbar";
import { E2E_BASE } from "./helpers/test-server";
import { canonicalTmpRoot } from "./helpers/file-project";
import { projectIdForPath as boardIdForPath } from "../../shared/board";

hermetic(test);

const STAMP = Date.now();
const NAME = "dispatchdash";
const ROOT = `${canonicalTmpRoot()}/e2e-${NAME}-${STAMP}`;
const DIR = `${ROOT}/${NAME}`;

// `__dirname`, not `import.meta.url`: Playwright transpiles the specs to CJS.
const UI_AUDIT_JS = readFileSync(resolve(__dirname, "helpers/ui-audit.js"), "utf8");
const SHOTS = process.env.DASH_SHOTS ?? join(process.cwd(), "test-results", "dispatch-dashboard");
const topicIds: string[] = [];
/** A 12-core machine at rest, with `running` agents in flight on a recommended 4. */
async function stubMachine(page: Page, running: number, recommended = 4) {
  await page.route((url) => url.pathname === "/api/system/dispatch-capacity", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        recommended, cores: 12, totalMemGB: 32, availableMemGB: 2.8, load1: 3.2, running,
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
  // Sixty minutes of free memory and working cards, like the server's series.
  const free = [4.6,4.5,4.7,4.4,4.3,4.5,4.6,4.4,4.3,4.4,4.5,4.4,4.3,4.2,4.4,4.5,4.3,4.2,4.3,4.4,4.3,4.2,4.1,4.3,4.2,4.2,
    3.8,3.9,3.7,3.8,3.6,3.7,3.9,3.8,3.7,3.6,3.8,3.7,3.6,3.7,3.2,3.1,3.0,2.9,3.0,3.1,3.0,2.9,2.8,2.7,2.6,2.7,2.8,2.9,3.0,2.9,2.8,2.8,2.9,2.8,2.8];
  const end = Date.now();
  const history = free.map((freeGB, i) => ({ at: new Date(end - (free.length - 1 - i) * 60_000).toISOString(), freeGB, running: i < 26 ? 0 : i < 39 ? 1 : 2 }));
  await page.route((url) => url.pathname === "/api/dispatch/memory-queue", (route) =>
    route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({
        reading: { freeGB: 2.8, at: null }, threshold: { startGB: 3.5 },
        queue: [], running: [],
        consumers: [
          { label: "App aperte", gb: 10.3 }, { label: "macOS", gb: 6.6 }, { label: "Strumenti di sviluppo", gb: 5.8 },
          { label: "Jarvis e altre sessioni di Claude", gb: 5.6 }, { label: "Le 2 card al lavoro", gb: 0.9 },
        ],
        history,
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

  /** Three cards queued for memory, in the order the test creates them (the oldest is first). */
  const QUEUED = ["Comando usage-hub consumo con previsioni e spie", "Un lavoro accodato si dice «non partito»", "Tray: PC al lavoro visibile in barra"];
  const created: string[] = [];
  test.beforeEach(async ({ request }) => {
    const projectId = boardIdForPath(DIR);
    for (const text of QUEUED) {
      const id = (await apiCreateTask(request, projectId, text, "todo")).split(":")[1]!;
      created.push(id);
      // As the dispatcher sets them when they wait for free memory: the wait Start anyway skips.
      const r = await request.post(`${E2E_BASE}/api/test/tasks/${id}/dispatch-state`, { data: { state: "queued", error: "waiting-memory" } });
      expect(r.ok(), `dispatch-state queued per «${text}»`).toBe(true);
    }
  });

  // Each test starts with ITS three cards: the previous test's would throw the count off.
  test.afterEach(async ({ request }) => {
    const projectId = boardIdForPath(DIR);
    for (const id of created.splice(0)) await request.delete(`${E2E_BASE}/api/boards/${projectId}/tasks/${id}`).catch(() => {});
  });

  test.afterAll(async ({ request }) => {
    for (const id of topicIds) await deleteTopic(request, id).catch(() => {});
    rmSync(ROOT, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await resetProjectPanes(page.request, DIR);
    await seedProjectPane(page.request, DIR);
    await page.setViewportSize({ width: 1600, height: 1800 });
  });

  test("DISPATCHDASH-01: la prima versione resta, con grafico, riga di stato e coda nuova sopra", async ({ page }) => {
    await stubMachine(page, 2);
    await stubQueue(page);
    // Start anyway goes to the real server (`start-anyway`); here the request is stopped and we check
    // that it starts for the right card: really starting it would launch an agent.
    const started: string[] = [];
    await page.route((url) => url.pathname.endsWith("/start-anyway"), (route) => {
      started.push(new URL(route.request().url()).pathname);
      return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ task: null }) });
    });
    await page.goto("/");
    await openBoard(page);
    await gear(page).click();
    const menu = page.getByTestId("board-settings-menu");
    const dash = menu.getByTestId("dispatch-dashboard");
    await expect(dash).toBeVisible();
    // The first version, as it was.
    await expect(menu.getByText("Impostazioni della board", { exact: true })).toBeVisible();
    await expect(dash.getByTestId("dispatch-dashboard-hero")).toHaveText("2 al lavoro · 3 in coda");
    // Auto-dispatch off in the test env: the row states the memory, it does not promise another one will start.
    // «Chi tiene la memoria» is closed by default and opens on request.
    // It lives inside Advanced, which is closed too.
    await expect(menu.getByTestId("settings-advanced")).not.toHaveAttribute("open", /.*/);
    await menu.getByTestId("settings-advanced").locator("summary").first().click();
    const fold = menu.getByTestId("dispatch-dashboard-holders-fold");
    await expect(menu.getByTestId("dispatch-dashboard-holders")).toBeHidden();
    await fold.locator("summary").click();
    await expect(menu.getByTestId("dispatch-dashboard-holders")).toContainText("Jarvis e altre sessioni di Claude");
    await expect(menu.getByText("Chi tiene la memoria del Mac · 32 GB")).toBeVisible();
    await fold.locator("summary").click();
    await expect(menu.getByTestId("dispatch-dashboard-switch")).toBeVisible();
    await expect(menu.getByText("Quante card insieme", { exact: true })).toBeVisible();
    await expect(menu.getByTestId("global-cap-running")).toBeVisible();
    // The three improvements.
    await expect(dash.getByTestId("dispatch-dashboard-live")).toHaveText("dal vivo");
    // The test env starts with Auto-dispatch off: the row does not promise they start by themselves.
    await expect(dash.getByTestId("dispatch-dashboard-answer")).toHaveText("Auto-dispatch spento: le 3 in coda partono quando lo accendi.");
    await expect(dash.getByTestId("dispatch-dashboard-turn-on")).toBeVisible();
    await dash.screenshot({ path: join(SHOTS, "riepilogo-spento.png") });
    const chart = menu.getByTestId("dispatch-chart");
    await expect(chart).toBeVisible();
    await expect(chart).toContainText("3,5 GB liberi: ne parte un’altra");
    await expect(chart).toContainText("2 card");
    const rows = menu.getByTestId("dispatch-dashboard-queue-row");
    await expect(rows).toHaveCount(3);
    for (let i = 0; i < QUEUED.length; i++) await expect(rows.nth(i)).toContainText(QUEUED[i]!);
    await expect(rows.first().getByTestId("dispatch-dashboard-queue-project")).toHaveText(NAME);
    await expect(rows.first()).toContainText("da 1 min");
    await expect(menu.getByTestId("dispatch-dashboard-start-now")).toHaveCount(1);
    await expect(rows.first().getByTestId("dispatch-dashboard-start-now")).toBeVisible();
    // The order: summary, queue, chart, how many cards together, Advanced (spend, who holds the memory).
    const ys = await Promise.all(["dispatch-dashboard-answer", "dispatch-dashboard-queue", "dispatch-chart-block", "global-cap-control", "dispatch-dashboard-holders-fold"]
      .map(async (id) => (await menu.getByTestId(id).boundingBox())!.y));
    expect([...ys].sort((p, q) => p - q), `ordine dei blocchi ${ys.join(",")}`).toEqual(ys);
    await menu.screenshot({ path: join(SHOTS, "pannello.png") });
    await menu.getByTestId("global-cap-running").scrollIntoViewIfNeeded();
    await menu.screenshot({ path: join(SHOTS, "pannello-sotto.png") });
    // Two cards at work: the server would refuse (seat taken), the button is disabled and says why.
    const button = rows.first().getByTestId("dispatch-dashboard-start-now");
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute("title", /già una card al lavoro/);
    expect(started).toHaveLength(0);
  });

  test("DISPATCHDASH-02: Mac libero, «Avvia comunque» chiama start-anyway per la prima; un rifiuto si legge in italiano", async ({ page }) => {
    await stubMachine(page, 0);
    await stubQueue(page);
    const started: string[] = [];
    let refuse = false;
    await page.route((url) => url.pathname.endsWith("/start-anyway"), (route) => {
      started.push(new URL(route.request().url()).pathname);
      return refuse
        ? route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "task cannot be started", code: "start_rejected" }) })
        : route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ task: null }) });
    });
    await page.goto("/");
    await openBoard(page);
    await gear(page).click();
    const menu = page.getByTestId("board-settings-menu");
    const dash = menu;
    const rows = menu.getByTestId("dispatch-dashboard-queue-row");
    await expect(rows).toHaveCount(3);
    const button = rows.first().getByTestId("dispatch-dashboard-start-now");
    await expect(button).toBeEnabled();
    await button.click();
    await expect.poll(() => started.length).toBe(1);
    expect(started[0], "parte la prima della coda, sulla sua board").toMatch(new RegExp(`/api/boards/${boardIdForPath(DIR)}/tasks/[^/]+/start-anyway$`));
    await expect(dash.getByTestId("dispatch-dashboard-start-error")).toHaveCount(0);
    refuse = true;
    await button.click();
    await expect(rows.first().getByTestId("dispatch-dashboard-start-error")).toHaveText("Non è partita: il Mac non la regge adesso (disco, spesa o CPU)");
    await expect(dash).not.toContainText("task cannot be started");
  });

  for (const width of [400, 1100]) {
    test(`DISPATCHDASH-03: il riquadro rosso elenca le card ferme, senza sforare a ${width} px, e il clic apre il drawer`, async ({ page, request }) => {
      await stubMachine(page, 0);
      await stubQueue(page);
      // Two of the three cards stop on a fault; the first has a title longer than the box.
      for (const id of created.slice(0, 2)) {
        const r = await request.post(`${E2E_BASE}/api/test/tasks/${id}/dispatch-state`, { data: { state: "failed", error: "Avvio agent fallito" } });
        expect(r.ok(), "dispatch-state failed").toBe(true);
      }
      await page.setViewportSize({ width, height: 1800 });
      await page.goto("/");
      await openBoard(page);
      await gear(page).click();
      const menu = page.getByTestId("board-settings-menu");
      const answer = menu.getByTestId("dispatch-dashboard-answer");
      await expect(answer).toContainText("2 card sono ferme per un guasto");
      const cards = menu.getByTestId("dispatch-dashboard-broken-card");
      await expect(cards).toHaveCount(2);
      // No horizontal overflow: neither the page nor the panel nor the red box scroll sideways.
      const overflow = await page.evaluate(() => {
        const wide = (el: Element | null) => (el ? el.scrollWidth - el.clientWidth : 0);
        const menuEl = document.querySelector('[data-testid="board-settings-menu"]');
        const list = document.querySelector('[data-testid="dispatch-dashboard-broken-list"]');
        const box = list?.parentElement ?? null;
        return { page: wide(document.documentElement), menu: wide(menuEl), box: wide(box), list: wide(list) };
      });
      expect(overflow, `overflow-X a ${width} px`).toEqual({ page: 0, menu: 0, box: 0, list: 0 });
      await menu.screenshot({ path: join(SHOTS, `guasti-${width}.png`) });
      // Click on a title: the panel closes and the drawer of THAT card opens.
      await cards.first().click();
      const drawer = page.getByTestId("task-detail-drawer");
      await expect(drawer).toBeVisible();
      await expect(drawer).toContainText(QUEUED[0]!);
      await expect(menu).toBeHidden();
    });
  }
  for (const width of [400, 1100]) {
    test(`DISPATCHDASH-04: spento con un guasto, «Accendi» c'è e funziona; la coda si legge senza sforare a ${width} px`, async ({ page, request }) => {
      await stubMachine(page, 0);
      await stubQueue(page);
      const r = await request.post(`${E2E_BASE}/api/test/tasks/${created[0]}/dispatch-state`, { data: { state: "failed", error: "Avvio agent fallito" } });
      expect(r.ok(), "dispatch-state failed").toBe(true);
      await page.setViewportSize({ width, height: 1800 });
      await page.goto("/");
      await openBoard(page);
      await gear(page).click();
      const menu = page.getByTestId("board-settings-menu");
      // The test env starts with Auto-dispatch off: the red box keeps the fault, the amber one says it is off.
      await expect(menu.getByTestId("dispatch-dashboard-answer")).toContainText("1 card è ferma per un guasto");
      const off = menu.getByTestId("dispatch-dashboard-off");
      await expect(off).toContainText("Auto-dispatch spento");
      await expect(off.getByTestId("dispatch-dashboard-turn-on")).toHaveCount(1);
      // DOM measure (helpers/ui-audit.js) of the whole panel, plus the queue rows cut by nothing.
      const audit = JSON.parse(await page.evaluate(`${UI_AUDIT_JS}\n__uiAudit({ scope: '[data-testid="board-settings-menu"]' })`) as string);
      mkdirSync(join(process.cwd(), "test-results", "ui-audit"), { recursive: true });
      writeFileSync(join(process.cwd(), "test-results", "ui-audit", `dispatch-panel-${width}.json`), JSON.stringify(audit, null, 2));
      expect(audit.overflowX.present, `overflow-X a ${width} px: ${JSON.stringify(audit.overflowX.offenders)}`).toBe(false);
      const cut = await page.evaluate(() => [...document.querySelectorAll('[data-testid="dispatch-dashboard-queue-row"] span, [data-testid^="dispatch-dashboard-"][data-testid$="-text"], [data-testid="dispatch-dashboard-answer"]')]
        .filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).display !== "inline").map((el) => el.getAttribute("data-testid") ?? el.textContent));
      expect(cut, "testo tagliato").toEqual([]);
      await menu.screenshot({ path: join(SHOTS, `spento-guasto-${width}.png`) });
      // The button does something: auto-dispatch goes on, and the "off" box goes away.
      const toggle = menu.getByTestId("dispatch-dashboard-switch");
      await expect(toggle).not.toBeChecked();
      await off.getByTestId("dispatch-dashboard-turn-on").click();
      await expect(menu.getByTestId("dispatch-dashboard-off")).toHaveCount(0);
      await expect(toggle).toBeChecked();
      // The switch is a server setting: put it back, the other tests start from "off".
      await toggle.click();
      await expect(toggle).not.toBeChecked();
    });
  }
});
