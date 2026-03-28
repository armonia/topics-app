import { test } from "./fixtures/dashboard.fixture";
import { expect } from "@playwright/test";

test.describe("Dashboard & Analytics", () => {
  test("DASH-01: KPI cards render with data", async ({
    page,
    dashboardPage,
  }) => {
    await dashboardPage.mockAllDashboardEndpoints();
    await page.goto("/");
    await dashboardPage.openDashboard();

    await expect(dashboardPage.kpiGrid).toBeVisible();
    await expect(dashboardPage.kpiCards).toHaveCount(10);

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

  test("DASH-02: KPI grid responsive layout", async ({
    page,
    dashboardPage,
  }) => {
    await dashboardPage.mockAllDashboardEndpoints();
    await page.goto("/");
    await dashboardPage.openDashboard();

    // Desktop viewport (default 1280x800) - all 10 cards visible
    await expect(dashboardPage.kpiCards).toHaveCount(10);

    // Resize to mobile
    await page.setViewportSize({ width: 375, height: 812 });

    // All 10 cards should still be visible (wrapped to multiple rows)
    await expect(dashboardPage.kpiCards).toHaveCount(10);
    for (let i = 0; i < 10; i++) {
      await expect(dashboardPage.kpiCards.nth(i)).toBeVisible();
    }
  });

  test("DASH-03: Time-series chart renders SVG with data", async ({
    page,
    dashboardPage,
  }) => {
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

  test("DASH-04: Range selector changes chart", async ({
    page,
    dashboardPage,
  }) => {
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

  test("DASH-05: Agent leaderboard table renders", async ({
    page,
    dashboardPage,
  }) => {
    await dashboardPage.mockAllDashboardEndpoints();
    await page.goto("/");
    await dashboardPage.openDashboard();

    await expect(dashboardPage.leaderboardTable).toBeVisible();

    // 7 column headers: #, Agent, Tasks Done, Tokens, Avg Cycle, Error Rate, Sessions
    await expect(dashboardPage.leaderboardHeaders).toHaveCount(7);

    // Verify key header text
    const headerTexts = await dashboardPage.leaderboardHeaders.allTextContents();
    expect(headerTexts).toContain("Agent");
    expect(headerTexts).toContain("Tasks Done");
    expect(headerTexts).toContain("Tokens");

    // 2 data rows matching mocked agents
    await expect(dashboardPage.leaderboardRows).toHaveCount(2);

    // First row contains "Claude"
    const firstRow = dashboardPage.leaderboardRows.nth(0);
    await expect(firstRow).toContainText("Claude");
  });
});
