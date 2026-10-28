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
import { apiCreateTask } from "./helpers/board-topbar";
import { E2E_BASE } from "./helpers/test-server";
import { canonicalTmpRoot } from "./helpers/file-project";
import { projectIdForPath as boardIdForPath } from "../../shared/board";

hermetic(test);

const STAMP = Date.now();
const NAME = "dispatchdash";
const ROOT = `${canonicalTmpRoot()}/e2e-${NAME}-${STAMP}`;
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
  // Sessanta minuti di memoria libera e di card al lavoro, come la serie del server.
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
          { label: "Card di Topics", gb: 0.9 }, { label: "App aperte", gb: 10.3 },
          { label: "Jarvis e sessioni", gb: 5.6 }, { label: "macOS", gb: 6.6 }, { label: "Strumenti di sviluppo", gb: 5.8 },
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

  /** Tre card «in coda», nell'ordine in cui le crea il test (la più vecchia è la prima). */
  const QUEUED = ["Comando usage-hub consumo con previsioni e spie", "Un lavoro accodato si dice «non partito»", "Tray: PC al lavoro visibile in barra"];
  test.beforeEach(async ({ request }) => {
    const projectId = boardIdForPath(DIR);
    for (const text of QUEUED) {
      const id = (await apiCreateTask(request, projectId, text, "in_progress")).split(":")[1]!;
      const r = await request.post(`${E2E_BASE}/api/test/tasks/${id}/dispatch-state`, { data: { state: "queued" } });
      expect(r.ok(), `dispatch-state queued per «${text}»`).toBe(true);
    }
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

  test("DASH-01: hero, grafico, coda in ordine, macchine, il tetto resta", async ({ page }) => {
    await stubMachine(page, 2);
    await stubQueue(page);
    await page.goto("/");
    await openBoard(page);
    await gear(page).click();
    const menu = page.getByTestId("board-settings-menu");
    const dash = menu.getByTestId("dispatch-dashboard");
    await expect(dash).toBeVisible();
    await expect(menu.getByText("Come partono le card", { exact: true })).toBeVisible();
    await expect(dash.getByTestId("dispatch-dashboard-hero")).toHaveText("2 al lavoro · 3 in coda");
    await expect(dash.getByTestId("dispatch-chart")).toBeVisible();
    const rows = dash.getByTestId("dispatch-dashboard-queue-row");
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toContainText("Comando usage-hub");
    await expect(menu.getByTestId("dispatch-machines-bar")).toBeVisible();
    await expect(menu.getByTestId("dispatch-dashboard-holders")).toContainText("10,3");
    await expect(menu.getByTestId("global-cap-running")).toBeVisible();
    // l'interruttore è lo stesso di sempre: label «Auto-dispatch» ancora raggiungibile
    await expect(page.locator("label", { hasText: "Auto-dispatch" }).getByRole("checkbox")).toBeVisible();
    // Misura sul DOM (non a occhio): posizione, misure e corpo del testo di ogni blocco, relativi al pannello.
    const geo = await menu.evaluate((root) => {
      const base = (root.querySelector('[data-testid="board-settings-panel"]') ?? root) as HTMLElement;
      const b = base.getBoundingClientRect();
      const pick = (name: string, el: Element | null) => {
        if (!el) return [name, null] as const;
        const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
        return [name, { x: Math.round(r.left - b.left), y: Math.round(r.top - b.top), w: Math.round(r.width), h: Math.round(r.height), fs: cs.fontSize, fw: cs.fontWeight }] as const;
      };
      const q = (s: string) => root.querySelector(s);
      const rows = root.querySelectorAll('[data-testid="dispatch-dashboard-queue-row"]');
      return Object.fromEntries([
        ["panel", { x: 0, y: 0, w: Math.round(b.width), h: Math.round(b.height) }] as const,
        pick("head", base.firstElementChild?.firstElementChild ?? null),
        pick("hero", q('[data-testid="dispatch-dashboard-hero-card"]')),
        pick("heroBig", q('[data-testid="dispatch-dashboard-hero"]')),
        pick("chart", q('[data-testid="dispatch-chart"]')),
        pick("queueRow1", rows[0] ?? null),
        pick("queueRow2", rows[1] ?? null),
        pick("machines", q('[data-testid="dispatch-machines"]')),
      ]);
    });
    writeFileSync(join(SHOTS, "geo-dopo.json"), JSON.stringify(geo, null, 1));
    await menu.screenshot({ path: join(SHOTS, "pannello.png") });
    await page.screenshot({ path: join(SHOTS, "pagina.png") });
  });
});
