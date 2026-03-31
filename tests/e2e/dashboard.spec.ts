import { test } from "./fixtures/dashboard.fixture";
import { expect } from "@playwright/test";

test.describe("Dashboard & Analytics", () => {
  test("DASH-01: KPI cards render with data", async ({
    page,
    dashboardPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "DASH-01" });
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
    test.info().annotations.push({ type: "spec", description: "DASH-01" });
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

  test("DASH-04: Range selector changes chart", async ({
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

  test("DASH-05: Agent leaderboard table renders", async ({
    page,
    dashboardPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "DASH-01" });
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

  test("DASH-06: Activity feed shows live events via SSE", async ({
    page,
    dashboardPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "DASH-01" });
    // Mock SSE activity stream with deterministic events BEFORE navigation
    await dashboardPage.mockActivityStream([
      {
        id: "evt-1",
        timestamp: "2026-03-28T10:00:00Z",
        category: "session",
        level: "info",
        title: "Agent started session",
      },
      {
        id: "evt-2",
        timestamp: "2026-03-28T10:01:00Z",
        category: "tool:exec",
        level: "info",
        title: "Executed build command",
      },
    ]);

    await page.goto("/");
    await dashboardPage.openActivityFeed();

    // Activity feed should be visible
    await expect(dashboardPage.activityFeed).toBeVisible();

    // Live tab should be visible (it's the default tab)
    await expect(dashboardPage.liveFeedTab).toBeVisible();

    // Wait for mocked events to appear in the feed
    await expect(
      dashboardPage.activityFeed.getByText("Agent started session"),
    ).toBeVisible();
    await expect(
      dashboardPage.activityFeed.getByText("Executed build command"),
    ).toBeVisible();

    // Should NOT show the empty state
    await expect(
      dashboardPage.activityFeed.getByText("No activity yet"),
    ).not.toBeVisible();
  });

  test("DASH-07: Journal pane loads with date navigation", async ({
    page,
    dashboardPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "DASH-01" });
    // Mock SSE stream (activity feed needs it to connect)
    await dashboardPage.mockActivityStream([]);

    // Mock journal REST endpoints with deterministic data BEFORE navigation
    await dashboardPage.mockJournalEndpoints({
      events: [
        {
          id: "j-evt-1",
          timestamp: "2026-03-28T09:00:00Z",
          type: "session_start",
          summary: "Started coding session for auth module",
        },
        {
          id: "j-evt-2",
          timestamp: "2026-03-28T09:30:00Z",
          type: "tool_call",
          summary: "Ran test suite with 42 passing tests",
        },
      ],
      digest: "Test journal digest entry",
    });

    await page.goto("/");
    await dashboardPage.openActivityFeed();

    // Click the Digest tab to lazy-load JournalPanel
    await dashboardPage.digestTab.click();

    // Wait for JournalPanel to load — the "Previous day" button confirms Suspense resolved
    await expect(dashboardPage.journalPrevDay).toBeVisible({ timeout: 10_000 });

    // Date navigation should be present
    await expect(dashboardPage.journalTodayButton).toBeVisible();

    // Journal tab should show the digest text
    await expect(page.getByText("Test journal digest entry")).toBeVisible();

    // Click the Events tab, verify event summaries appear
    await dashboardPage.journalEventsTab.click();
    await expect(
      page.getByText("Started coding session for auth module"),
    ).toBeVisible();
    await expect(
      page.getByText("Ran test suite with 42 passing tests"),
    ).toBeVisible();

    // Get current date text from the today button
    const dateBefore = await dashboardPage.journalTodayButton.textContent();

    // Click "Previous day" and wait for date to change
    await dashboardPage.journalPrevDay.click();
    await expect(dashboardPage.journalTodayButton).not.toHaveText(dateBefore!);

    // Date should have updated
    const dateAfter = await dashboardPage.journalTodayButton.textContent();
    expect(dateAfter).not.toBe(dateBefore);
  });
});
