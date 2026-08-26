import { test } from "./fixtures/dashboard.fixture";
import { expect } from "@playwright/test";
import { resetPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

test.describe("Dashboard & Analytics", () => {
  // Clear panes leaked by earlier specs (the shared pane-store-v2 UNIONs in on
  // hydrate). The dashboard opens as an overlay over whatever panes are tiled;
  // leaked project panes bring their own title="Refresh" (GitChanges,
  // FileExplorer, ProjectSidebar) which collide with the journal's Refresh in
  // DASH-23. An empty store leaves only the dashboard's own controls.
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, []);
  });

  test("KPI-01: KPI cards render with data", async ({
    page,
    dashboardPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "DASH-01" });
    await dashboardPage.mockAllDashboardEndpoints();
    await page.goto("/");
    await dashboardPage.openDashboard();

    await expect(dashboardPage.kpiGrid).toBeVisible();
    await expect(dashboardPage.kpiCards).toHaveCount(9);

    // Each card should have a non-empty value
    const cards = dashboardPage.kpiCards;
    const count = await cards.count();
    for (let i = 0; i < count; i++) {
      const valueSpan = cards.nth(i).locator("span.font-semibold").first();
      await expect(valueSpan).not.toBeEmpty();
      const text = await valueSpan.textContent();
      expect(text?.trim()).not.toBe("");
      expect(text?.trim()).not.toBe("0");
    }
  });

  test("KPI-02: KPI grid responsive layout", async ({
    page,
    dashboardPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "DASH-01" });
    await dashboardPage.mockAllDashboardEndpoints();
    await page.goto("/");
    await dashboardPage.openDashboard();

    // Desktop viewport (default 1280x800) - all 9 cards visible
    await expect(dashboardPage.kpiCards).toHaveCount(9);

    // Resize to mobile
    await page.setViewportSize({ width: 375, height: 812 });

    // All 9 cards should still be visible (wrapped to multiple rows)
    await expect(dashboardPage.kpiCards).toHaveCount(9);
    for (let i = 0; i < 9; i++) {
      await expect(dashboardPage.kpiCards.nth(i)).toBeVisible();
    }
  });

  test("KPI-03: Time-series chart renders SVG with data", async ({
    page,
    dashboardPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "DASH-01" });
    await dashboardPage.mockAllDashboardEndpoints();
    await page.goto("/");
    await dashboardPage.openDashboard();

    await expect(dashboardPage.chartSvg).toBeVisible();

    // At least 2 paths: area fill + line
    const pathCount = await dashboardPage.chartPaths.count();
    expect(pathCount).toBeGreaterThanOrEqual(2);

    // Each path should have a non-empty d attribute
    for (let i = 0; i < pathCount; i++) {
      await expect(dashboardPage.chartPaths.nth(i)).toHaveAttribute("d", /.+/);
    }

    // Data point circles should exist (default range 7d = 7 points)
    const circleCount = await dashboardPage.chartCircles.count();
    expect(circleCount).toBeGreaterThan(0);

    // SVG text elements for axis labels
    const textElements = dashboardPage.chartSvg.locator("text");
    const textCount = await textElements.count();
    expect(textCount).toBeGreaterThan(0);
  });

  test("KPI-04: Range selector changes chart", async ({
    page,
    dashboardPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "DASH-01" });
    await dashboardPage.mockAllDashboardEndpoints();
    await page.goto("/");
    await dashboardPage.openDashboard();

    await expect(dashboardPage.chartSvg).toBeVisible();

    // Record initial chart state (default range is 7d -> 7 circles)
    const initialCircleCount = await dashboardPage.chartCircles.count();
    expect(initialCircleCount).toBe(7);

    // Get initial line path d attribute
    const linePath = dashboardPage.chartPaths.nth(1);
    const initialD = await linePath.getAttribute("d");
    expect(initialD).toBeTruthy();

    // Click "30d" range button
    await dashboardPage.rangeButtons.getByText("30d").click();

    // Wait for chart to update: path d attribute should change
    await expect(linePath).not.toHaveAttribute("d", initialD!);

    // 30d range should have 30 circles
    await expect(dashboardPage.chartCircles).toHaveCount(30);
  });

  test("KPI-08: KPI cards show descriptive labels", async ({
    page,
    dashboardPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "DASH-01" });
    await dashboardPage.mockAllDashboardEndpoints();
    await page.goto("/");
    await dashboardPage.openDashboard();

    await expect(dashboardPage.kpiCards).toHaveCount(9);

    // Each KPI card should have non-empty text content (label + value)
    const cards = dashboardPage.kpiCards;
    const count = await cards.count();
    for (let i = 0; i < count; i++) {
      const cardText = await cards.nth(i).textContent();
      expect(cardText?.trim()).not.toBe("");
    }

    // Verify the overall dashboard section contains recognizable KPI text
    const dashText = (await dashboardPage.kpiCards.first().locator("..").locator("..").textContent()) ?? "";
    // KPI section should have numeric values (the mock data provides specific numbers)
    expect(dashText).toMatch(/\d+/);
  });

  test("KPI-09: Default chart range shows 7 data points", async ({
    page,
    dashboardPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "DASH-01" });
    await dashboardPage.mockAllDashboardEndpoints();
    await page.goto("/");
    await dashboardPage.openDashboard();

    await expect(dashboardPage.chartSvg).toBeVisible();

    // Default range is 7d which should produce exactly 7 circle data points
    await expect(dashboardPage.chartCircles).toHaveCount(7);
  });

  test("KPI-10: Range selector buttons visible", async ({
    page,
    dashboardPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "DASH-01" });
    await dashboardPage.mockAllDashboardEndpoints();
    await page.goto("/");
    await dashboardPage.openDashboard();

    // Verify all three range buttons are visible
    await expect(dashboardPage.rangeSelector).toBeVisible();
    await expect(
      dashboardPage.rangeSelector.getByText("1d"),
    ).toBeVisible();
    await expect(
      dashboardPage.rangeSelector.getByText("7d"),
    ).toBeVisible();
    await expect(
      dashboardPage.rangeSelector.getByText("30d"),
    ).toBeVisible();
  });

  test("KPI-14: Chart area fill and line paths render distinctly", async ({
    page,
    dashboardPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "DASH-01" });
    await dashboardPage.mockAllDashboardEndpoints();
    await page.goto("/");
    await dashboardPage.openDashboard();

    await expect(dashboardPage.chartSvg).toBeVisible();

    // At least 2 paths: area fill + line
    const pathCount = await dashboardPage.chartPaths.count();
    expect(pathCount).toBeGreaterThanOrEqual(2);

    // Area fill path and line path should have different d attributes
    const areaD = await dashboardPage.chartPaths.nth(0).getAttribute("d");
    const lineD = await dashboardPage.chartPaths.nth(1).getAttribute("d");
    expect(areaD).toBeTruthy();
    expect(lineD).toBeTruthy();
    expect(areaD).not.toBe(lineD);
  });

  test("KPI-15: Dashboard navigation from sidebar", async ({
    page,
    dashboardPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "DASH-01" });
    await dashboardPage.mockAllDashboardEndpoints();
    await page.goto("/");

    // Il menu «New» (⌘N) della sidebar è l'UNICO posto da cui si apre una pane:
    // la riga si chiama «Dashboard», come la tab che apre. Prima era
    // «Statistics» nel dropdown «Settings & Tools» — un secondo menu di
    // creazione con nomi propri.
    // By TESTID and not by title: the title carries the shortcut, which since
    // 39db727c5 is written per platform — "⌘N" on a Mac, "Ctrl+N" on Windows and
    // Linux. A selector looking for the Mac glyph finds a button only on the
    // machine of whoever wrote it; on CI (Linux) it waits fifteen seconds for
    // something that is not there. Measured: 0 elements found.
    await page.getByTestId("pane-add-menu-trigger").click();
    const dashboardRow = page.getByTestId("pane-add-menu-dashboard");
    await expect(dashboardRow).toBeVisible({ timeout: 5000 });
    await dashboardRow.click();

    // Verify dashboard pane is visible with KPI grid
    await expect(dashboardPage.pane).toBeVisible({ timeout: 10_000 });
    await expect(dashboardPage.kpiGrid).toBeVisible();
    await expect(dashboardPage.kpiCards).toHaveCount(9);
  });

  // ── DASH-02: Activity Feed Interactions ──────────────────────

});
