/**
 * CONSUMI IN THE DASHBOARD (hub-smistamento, HUBBR-12).
 *
 * «Consumi» in the menu with your name opens the Dashboard. With the hub it is
 * the hub's numbers: «Decidi tu» with the project past its cap and «Alza a N%»
 * written to the hub and read back, the five numbers in euro (what the Claude
 * plans cost for the week is fixed by the fixture: 500 dollars a month, 107 €
 * a week at 0.92), the tokens per model over time, per model, per account
 * (Claude from the proxy, Codex and Muse read-only), per project with the caps,
 * the saving for Claude only, the board's work in one box, and the usage per
 * project that left the System level. The cap is on the Claude week, as the
 * hub's brake reads it: studio-x at 25% of Claude on a 25% cap is past it.
 * Then the drill-down the hub's page had: the window narrowed to a folder
 * and exported as CSV, input, output and requests, each day's tokens and
 * euro on hover, every model and account with tokens and list price (a
 * removed account included), per folder and branch, a project's requests and
 * who made them, the rest of the projects opened, Muse per folder, the
 * proxy's attribution, and the curve of the plans paying for themselves. Without the hub, after a reload, the
 * Dashboard is the board's numbers with the usage per project, and nothing of
 * the hub.
 *
 * The hub is a fake (helpers/fake-hub.ts) on the port the test server reads;
 * it also answers for the Claude proxy, raw rows included, which the Topics
 * server sums (`/api/hub-usage`). The real :3360 and :3335 are never touched,
 * and the names are placeholders.
 *
 * Mutation: with `planCostForWindow` (lib/hubUsage.ts) spreading the plans over
 * 30 days whatever the window, «107 €» is red; with the raise sent to the
 * proxy instead of the hub, the post never reaches `project-settings`.
 *
 * The shots are taken in the mockups' workspace (helpers/shot-scene.ts):
 * acme-web and studio-x with their chats in the sidebar, a chat with messages.
 *
 * Video on: the recording is the proof. The screenshots of the built surface go
 * to the test's output (`vero-consumi-in-dashboard-*.png`).
 *
 * @covers HUBBR-12
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { resetPaneStore } from "./helpers/api-fixtures";
import { openMainChat, openSceneInSidebar, seedScene, type Scene } from "./helpers/shot-scene";
import { goToApp } from "./helpers";
import { openPerfPanel, openProfileMenu } from "./helpers/open-perf-panel";
import { startFakeHub, type FakeHub } from "./helpers/fake-hub";
import { E2E_BASE, canonicalTmpRoot } from "./helpers/test-server";

hermetic(test);
test.use({ video: "on" });
test.describe.configure({ mode: "serial", timeout: 150_000 });

const PANE = "dashboard-pane";

async function waitForHub(request: APIRequestContext): Promise<void> {
  await expect.poll(async () => {
    const snap = (await (await request.get(`${E2E_BASE}/api/hub-live`)).json()) as Record<string, { data?: unknown[] }>;
    return Array.isArray(snap.pace?.data) ? snap.pace.data.length : -1;
  }, { timeout: 30_000, message: "the live reader never read the fake hub" }).toBe(3);
}

async function waitForHubDown(request: APIRequestContext): Promise<void> {
  await expect.poll(async () => {
    const snap = (await (await request.get(`${E2E_BASE}/api/hub-live`)).json()) as Record<string, { error?: string }>;
    return typeof snap.pace?.error;
  }, { timeout: 30_000 }).toBe("string");
}

async function openDashboard(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("topics:open-utility", { detail: { type: "dashboard" } }));
    return document.querySelector('[data-testid="dashboard-pane"]') !== null;
  }), { timeout: 20_000 }).toBe(true);
}

test.describe("consumi in the dashboard", () => {
  let hub: FakeHub | null = null;
  let scene: Scene | null = null;

  test.beforeAll(async ({ request }) => {
    scene = await seedScene(request, `${canonicalTmpRoot()}/e2e-dashboard-consumi-${Date.now().toString(36)}`);
    hub = await startFakeHub();
    await waitForHub(request);
  });
  test.afterAll(async ({ request }) => {
    await hub?.close();
    await scene?.cleanup(request);
  });

  // Each test starts on the scene alone: a view opened by the test before
  // stays a tab, and clicking its row again would only focus that tab.
  test.beforeEach(async ({ request }) => {
    if (!scene) return;
    await resetPaneStore(request, []);
    await openSceneInSidebar(request, scene);
  });

  test("phone, 390 px: one column, nothing wider than the screen", async ({ browser }, testInfo) => {
    const ctx = await browser.newContext({
      baseURL: E2E_BASE, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: "dark", locale: "it-IT",
      recordVideo: { dir: testInfo.outputPath("phone-video"), size: { width: 390, height: 844 } },
    });
    const page = await ctx.newPage();
    try {
      await page.goto("/");
      await expect(page.getByTestId("mobile-chrome-bar")).toBeVisible({ timeout: 30_000 });
      await openDashboard(page);
      const pane = page.getByTestId(PANE);
      await expect(pane.getByTestId("hub-usage-section")).toBeVisible({ timeout: 20_000 });
      await expect(pane.getByTestId("hub-usage-decide")).toBeVisible({ timeout: 20_000 });
      await expect(pane.getByTestId("hub-usage-model-row")).toHaveCount(3, { timeout: 20_000 });
      const widths = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth,
        pane: document.querySelector<HTMLElement>('[data-testid="dashboard-pane"]')!.scrollWidth,
      }));
      expect(widths.doc).toBeLessThanOrEqual(390);
      expect(widths.pane).toBeLessThanOrEqual(390);
      // Two numbers a row: the second KPI sits beside the first, the third under them.
      const [a, b, c] = await Promise.all(["tokens", "list", "paid"].map((k) => pane.getByTestId(`hub-usage-kpi-${k}`).boundingBox()));
      expect(Math.abs(b!.y - a!.y)).toBeLessThan(2);
      expect(c!.y).toBeGreaterThan(a!.y + a!.height - 1);
      // The breakdowns stack: per account under per model.
      const [models, accounts] = await Promise.all([pane.getByTestId("hub-usage-models").boundingBox(), pane.getByTestId("hub-usage-accounts").boundingBox()]);
      expect(accounts!.y).toBeGreaterThan(models!.y + models!.height - 1);
      await page.screenshot({ path: testInfo.outputPath("vero-consumi-in-dashboard-telefono.png") });
    } finally {
      await ctx.close();
    }
  });

  test("the row with your name opens Consumi: the hub's numbers in euro, the cap raised on the hub", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "dark" });
    await goToApp(page);
    await openMainChat(page, scene!);

    // The usage per project is no longer a level of System.
    await openPerfPanel(page);
    await expect(page.getByTestId("menu-system-processes")).toBeVisible();
    await expect(page.getByTestId("menu-usage-projects")).toHaveCount(0);
    await page.reload();

    await openProfileMenu(page);
    await expect(page.getByTestId("menu-usage-tail")).toHaveText(/^oggi [\d,]+ [Mk] tok · \d+\s€$/, { timeout: 20_000 });
    await page.getByTestId("menu-usage").click();
    const pane = page.getByTestId(PANE);
    const section = pane.getByTestId("hub-usage-section");
    await expect(section).toBeVisible({ timeout: 20_000 });
    await expect(section.locator("h1")).toHaveText("Consumi");
    await expect(pane.getByTestId("hub-usage-live")).toHaveAttribute("data-live", "true", { timeout: 20_000 });

    // The decision first: the project past the cap you set, with the raise.
    const decide = pane.getByTestId("hub-usage-decide");
    await expect(decide).toContainText("studio-x ha passato il tetto che hai messo: 25% della settimana Claude su 25%", { timeout: 20_000 });
    await expect(decide.getByTestId("hub-usage-raise")).toHaveText("Alza a 35%");

    // Five numbers in euro: the plans of the fixture are 500 dollars a month, a week is 107 €.
    await expect(pane.getByTestId("hub-usage-kpi-tokens")).toContainText("Token della settimana");
    await expect(pane.getByTestId("hub-usage-kpi-tokens")).toContainText(/\d+M token/, { timeout: 20_000 });
    await expect(pane.getByTestId("hub-usage-kpi-list")).toContainText(/\d[\d.]*\s€/);
    await expect(pane.getByTestId("hub-usage-kpi-paid")).toContainText(/107\s€/);
    await expect(pane.getByTestId("hub-usage-kpi-paid")).toContainText("4 abbonamenti");
    await expect(pane.getByTestId("hub-usage-kpi-saved")).toContainText(/×\d/);
    await expect(pane.getByTestId("hub-usage-kpi-muse")).toContainText("3lavori");
    await expect(pane.getByTestId("hub-usage-kpis")).not.toContainText("$");

    // Per model, per account, per project.
    await expect(pane.getByTestId("hub-usage-model-row")).toHaveCount(3);
    await expect(pane.getByTestId("hub-usage-model-row").first()).toContainText("Opus 5.5");
    await expect(pane.getByTestId("hub-usage-account-row")).toHaveCount(4);
    await expect(pane.getByTestId("hub-usage-account-row").first()).toContainText("lavoro@example.com");
    await expect(pane.getByTestId("hub-usage-account-row").first()).toContainText("in uso");
    await expect(pane.getByTestId("hub-usage-metered-row")).toHaveCount(2);
    await expect(pane.getByTestId("hub-usage-project-row")).toHaveCount(4);
    await expect(pane.getByTestId("hub-usage-project-row").nth(1)).toHaveAttribute("data-over", "true");
    await expect(pane.getByTestId("hub-usage-project-rest")).toContainText("altri 2");

    // The saving is Claude's only; Muse is what it took off Claude.
    const saving = pane.getByTestId("hub-usage-saving");
    await expect(saving).toContainText("Abbonamenti Claude");
    await expect(saving).toContainText("10,5M token tolti a Claude");
    await expect(saving).not.toContainText("Codex");
    await expect(saving).not.toContainText("ChatGPT");

    // The board's work, the Dashboard's chart and the usage per project below.
    await expect(pane.getByTestId("hub-usage-board")).toContainText("Lavoro della board");
    await expect(pane.getByTestId("dashboard-chart")).toBeVisible();
    await expect(pane.getByTestId("dashboard-project-usage")).toContainText("Consumo per progetto");

    await page.screenshot({ path: testInfo.outputPath("vero-consumi-in-dashboard-scuro.png") });
    await page.emulateMedia({ colorScheme: "light" });
    await page.screenshot({ path: testInfo.outputPath("vero-consumi-in-dashboard-chiaro.png") });
    await page.emulateMedia({ colorScheme: "dark" });

    // The raise goes to the hub, and the view reads the new cap back.
    await decide.getByTestId("hub-usage-raise").click();
    await expect.poll(() => hub!.posts).toContainEqual({ path: "project-settings", name: "studio-x", budgetPct: 35 });
    await expect(pane.getByTestId("hub-usage-decide")).toHaveCount(0, { timeout: 10_000 });
    await expect(pane.getByTestId("hub-usage-project-row").nth(1)).toContainText("25% / 35%");

    // Today: the same view on today's window.
    await pane.getByTestId("hub-usage-range-1").click();
    await expect(pane.getByTestId("hub-usage-kpi-tokens")).toContainText("Token di oggi");
    await expect(pane.getByTestId("hub-usage-kpi-paid")).toContainText(/15,33\s€/, { timeout: 20_000 });
  });

  test("the drill-down: a folder, a model, an account; the CSV; who made a project's week; Muse per folder; the proxy's attribution", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "dark" });
    await goToApp(page);
    await openDashboard(page);
    const pane = page.getByTestId(PANE);
    await expect(pane.getByTestId("hub-usage-section")).toBeVisible({ timeout: 20_000 });

    // Input, output and requests of the week: 28 rows of acme-web and 4 more.
    await expect(pane.getByTestId("hub-usage-split-requests")).toHaveText(/^Richieste\s*32$/, { timeout: 20_000 });
    await expect(pane.getByTestId("hub-usage-split-input")).toContainText(/\d/);
    await expect(pane.getByTestId("hub-usage-split-output")).toContainText(/\dM/);
    // Each day's tokens and euro on hover.
    await expect(pane.getByTestId("hub-usage-bucket")).toHaveCount(7);
    await expect(pane.getByTestId("hub-usage-bucket").last().locator("title")).toHaveText(/: [\d,]+M token · [\d.,]+\s€$/);

    // Every model with its list price, every account with what it carried, the removed one too.
    await expect(pane.getByTestId("hub-usage-model-money")).toHaveCount(3);
    await expect(pane.getByTestId("hub-usage-model-money").first()).toContainText("€");
    const gone = pane.locator('[data-testid="hub-usage-account-row"][data-account="vecchio@example.com"]');
    await expect(gone).toHaveAttribute("data-state", "removed");
    await expect(gone).toContainText("tolto");
    await expect(gone.getByTestId("hub-usage-account-carried")).toContainText(/token · [\d,]+\s€ a listino · 1 rich\./);

    // Per folder and branch: acme-web, studio-x and the empty folder; studio-x opens on its two branches.
    await expect(pane.getByTestId("hub-usage-repo-row")).toHaveCount(3);
    await expect(pane.locator('[data-testid="hub-usage-repo-row"][data-repo=""]')).toContainText("(senza cartella)");
    await pane.locator('[data-testid="hub-usage-repo-row"][data-repo="studio-x"]').click();
    await expect(pane.getByTestId("hub-usage-branch-row")).toHaveCount(2);
    await expect(pane.locator('[data-testid="hub-usage-branch-row"][data-branch="feat/conti"]')).toBeVisible();

    // A project's week: what it is on hover, its requests and who made them one click away, the rest opened.
    const acme = pane.locator('[data-testid="hub-usage-project-row"][data-project="acme-web"]');
    await expect(acme).toHaveAttribute("title", /^Sito di acme \(esempio\) · Claude 30%/);
    await acme.click();
    const detail = pane.getByTestId("hub-usage-project-detail");
    await expect(detail).toContainText(/9\.?231 rich\. · 257M token · ultima/);
    await expect(detail).toContainText(/di cui sottoagenti 15,3% · 7\.?522 rich\. · Jarvis 0,4% · 12 rich\. · jcode 0,1% · 75 rich\./);
    await pane.getByTestId("hub-usage-project-rest").click();
    await expect(pane.getByTestId("hub-usage-project-row")).toHaveCount(6);

    // Muse per folder: six rows, and the seventh behind the row that opens the rest.
    await expect(pane.getByTestId("hub-usage-muse-row")).toHaveCount(6);
    await expect(pane.getByTestId("hub-usage-muse-row").first()).toContainText("41,5%");
    await pane.getByTestId("hub-usage-muse-rest").click();
    await expect(pane.getByTestId("hub-usage-muse-row")).toHaveCount(7);

    // How the proxy put its requests in folders: the period, what it could not place, the source per folder.
    await expect(pane.getByTestId("hub-usage-proxy-summary")).toContainText("14.569 richieste da");
    await expect(pane.getByTestId("hub-usage-proxy-summary")).toContainText("27 sessioni senza cartella · 3 richieste senza cartella");
    await expect(pane.locator('[data-testid="hub-usage-proxy-row"][data-source="logs"]')).toContainText("dai log di sessione");

    // The plans paying for themselves, day by day.
    await expect(pane.getByTestId("hub-usage-saving-curve")).toContainText("risparmio nel periodo");
    await pane.getByTestId("hub-usage-saving").scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("vero-consumi-dettaglio-scuro.png"), fullPage: true });

    // Narrowed to the studio-x folder: two requests, one model, one folder; the CSV carries the same rows.
    await pane.getByTestId("hub-usage-filter-repo").click();
    await page.getByRole("option", { name: "studio-x", exact: true }).click();
    await expect(pane.getByTestId("hub-usage-split-requests")).toHaveText(/^Richieste\s*2$/, { timeout: 20_000 });
    await expect(pane.getByTestId("hub-usage-repo-row")).toHaveCount(1);
    await expect(pane.getByTestId("hub-usage-model-row")).toHaveCount(1);
    await expect(pane.getByTestId("hub-usage-filter-repo")).toContainText("studio-x");
    const [download] = await Promise.all([page.waitForEvent("download"), pane.getByTestId("hub-usage-csv").click()]);
    expect(download.suggestedFilename()).toMatch(/^consumi-\d{4}-\d{2}-\d{2}\.csv$/);
    const csv = (await import("node:fs")).readFileSync((await download.path())!, "utf8").split("\n");
    expect(csv[0]).toBe("timestamp,repo,branch,model,account,input_tokens,output_tokens");
    expect(csv).toHaveLength(3);
    expect(csv.slice(1).every((l) => l.includes('"/w/studio-x"'))).toBe(true);

    // Narrowed to a model the folder does not have: nothing to export, said so.
    await pane.getByTestId("hub-usage-filter-model").click();
    await page.getByRole("option", { name: "Opus 5.5", exact: true }).click();
    await expect(pane.getByTestId("hub-usage-split-requests")).toHaveText(/^Richieste\s*0$/, { timeout: 20_000 });
    await pane.getByTestId("hub-usage-csv").click();
    await expect(pane.getByTestId("hub-usage-csv-note")).toHaveText("Niente da esportare");
    await page.screenshot({ path: testInfo.outputPath("vero-consumi-filtrato-scuro.png") });
  });

  test("hub gone, after a reload: the board's numbers and the usage per project, nothing of the hub", async ({ page, request }) => {
    const errors: string[] = [];
    // WebKit raises «ResizeObserver loop completed with undelivered notifications» as an
    // uncaught error: a layout notice of the engine, not an exception of the app.
    page.on("pageerror", (e) => { if (!e.message.startsWith("ResizeObserver loop")) errors.push(e.message); });
    await page.setViewportSize({ width: 1440, height: 900 });
    await hub!.close();
    hub = null;
    await waitForHubDown(request);
    await goToApp(page);
    await openProfileMenu(page);
    await expect(page.getByTestId("menu-usage")).toBeVisible();
    await expect(page.getByTestId("menu-usage-tail")).toHaveCount(0);
    await page.getByTestId("menu-usage").click();
    const pane = page.getByTestId(PANE);
    await expect(pane.getByTestId("kpi-card-grid")).toBeVisible({ timeout: 20_000 });
    await expect(pane.getByTestId("dashboard-project-usage")).toContainText("Consumo per progetto");
    await expect(pane.getByTestId("hub-usage-section")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
