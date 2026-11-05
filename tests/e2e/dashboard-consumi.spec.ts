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
 * project that left the System level. Without the hub, after a reload, the
 * Dashboard is the board's numbers with the usage per project, and nothing of
 * the hub.
 *
 * The hub is a fake (helpers/fake-hub.ts) on the port the test server reads;
 * it also answers for the Claude proxy, raw rows included, which the Topics
 * server sums (`/api/hub-usage`). The real :3360 and :3335 are never touched,
 * and the names are placeholders.
 *
 * Mutation: with `paidForWindow` (lib/hubUsage.ts) spreading the plans over
 * 30 days whatever the window, «107 €» is red; with the raise sent to the
 * proxy instead of the hub, the post never reaches `project-settings`.
 *
 * Video on: the recording is the proof. The screenshots of the built surface go
 * to the test's output (`vero-consumi-in-dashboard-*.png`).
 *
 * @covers HUBBR-12
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { goToApp } from "./helpers";
import { openPerfPanel, openProfileMenu } from "./helpers/open-perf-panel";
import { startFakeHub, type FakeHub } from "./helpers/fake-hub";
import { E2E_BASE } from "./helpers/test-server";

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

  test.beforeAll(async ({ request }) => {
    hub = await startFakeHub();
    await waitForHub(request);
  });
  test.afterAll(async () => {
    await hub?.close();
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
    await expect(decide).toContainText("studio-x ha passato il tetto che hai messo: 27% della settimana su 25%", { timeout: 20_000 });
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
    await expect(pane.getByTestId("hub-usage-account-row")).toHaveCount(3);
    await expect(pane.getByTestId("hub-usage-account-row").first()).toContainText("lavoro@example.com");
    await expect(pane.getByTestId("hub-usage-account-row").first()).toContainText("in uso");
    await expect(pane.getByTestId("hub-usage-metered-row")).toHaveCount(2);
    await expect(pane.getByTestId("hub-usage-project-row")).toHaveCount(4);
    await expect(pane.getByTestId("hub-usage-project-row").nth(1)).toHaveAttribute("data-over", "true");
    await expect(pane.getByTestId("hub-usage-project-rest")).toContainText("altri 2");

    // The saving is Claude's only; Muse is what it took off Claude.
    const saving = pane.getByTestId("hub-usage-saving");
    await expect(saving).toContainText("Abbonamenti Claude");
    await expect(saving).toContainText("9,1M token tolti a Claude");
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
    await expect(pane.getByTestId("hub-usage-project-row").nth(1)).toContainText("27% / 35%");

    // Today: the same view on today's window.
    await pane.getByTestId("hub-usage-range-1").click();
    await expect(pane.getByTestId("hub-usage-kpi-tokens")).toContainText("Token di oggi");
    await expect(pane.getByTestId("hub-usage-kpi-paid")).toContainText(/15,33\s€/, { timeout: 20_000 });
  });

  test("hub gone, after a reload: the board's numbers and the usage per project, nothing of the hub", async ({ page, request }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
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
