import { test as base, type Page } from "@playwright/test";
import { mockOpenClawAvailable, openTopicsMenuItem } from "../helpers/openclaw";

/**
 * Deterministic mock data for dashboard E2E tests.
 * All values are fixed (no Math.random) to ensure reproducible assertions.
 */
const MOCK_KPIS = {
  throughputDay: 12,
  throughputWeek: 47,
  avgCycleTimeHours: 3.2,
  wipCount: 5,
  errorRate: 0.03,
  tokenSpendDay: 4.56,
  tokenSpendWeek: 23.89,
  agentUtilization: 0.72,
  approvalTurnaroundHours: 1.5,
  pendingApprovals: 3,
};

function generatePoints(count: number): Array<{ date: string; value: number }> {
  return Array.from({ length: count }, (_, i) => ({
    date: `2026-03-${String(i + 1).padStart(2, "0")}`,
    value: 10 + i * 3,
  }));
}

const MOCK_TIMESERIES: Record<string, Array<{ date: string; value: number }>> =
  {
    "1d": generatePoints(24),
    "7d": generatePoints(7),
    "30d": generatePoints(30),
  };

const MOCK_AGENTS = [
  {
    agentId: "a1",
    agentName: "Claude",
    avatarEmoji: "",
    tasksCompleted: 15,
    totalTokens: 50000,
    avgCycleTimeHours: 2.1,
    errorRate: 0.02,
    sessionsCount: 8,
  },
  {
    agentId: "a2",
    agentName: "Agent-2",
    avatarEmoji: "",
    tasksCompleted: 10,
    totalTokens: 30000,
    avgCycleTimeHours: 3.5,
    errorRate: 0.05,
    sessionsCount: 5,
  },
];

export class DashboardPage {
  constructor(private page: Page) {}

  // --- Navigation ---

  /**
   * Open the dashboard pane via the sidebar "Topics" dropdown -> "Statistics" button.
   */
  async openDashboard() {
    // Click the "Topics" button (title="Settings & Tools") in sidebar header to open dropdown
    const topicsBtn = this.page.locator('button[title="Settings & Tools"]');
    await topicsBtn.click();

    // Click "Statistics" in the dropdown menu
    const statsBtn = this.page.locator(
      'button:has-text("Statistics"):visible',
    );
    await statsBtn.click();

    // Wait for the dashboard pane to be visible
    await this.pane.waitFor({ state: "visible", timeout: 10_000 });
  }

  // --- Locators ---

  get pane() {
    return this.page.locator('[data-testid="dashboard-pane"]');
  }

  get kpiGrid() {
    return this.page.locator('[data-testid="kpi-card-grid"]');
  }

  get kpiCards() {
    return this.page.locator('[data-testid="kpi-card"]');
  }

  get chartContainer() {
    return this.page.locator('[data-testid="dashboard-chart"]');
  }

  get chartSvg() {
    return this.chartContainer.locator("svg");
  }

  get chartPaths() {
    return this.chartSvg.locator("path");
  }

  get chartCircles() {
    return this.chartSvg.locator("circle");
  }

  get rangeSelector() {
    return this.page.locator('[data-testid="range-selector"]');
  }

  get rangeButtons() {
    return this.rangeSelector.locator("button");
  }

  get leaderboard() {
    return this.page.locator('[data-testid="agent-leaderboard"]');
  }

  get leaderboardTable() {
    return this.leaderboard.locator("table");
  }

  get leaderboardHeaders() {
    return this.leaderboardTable.locator("th");
  }

  get leaderboardRows() {
    return this.leaderboardTable.locator("tbody tr");
  }

  // --- Activity Feed Navigation ---

  /**
   * Open the activity feed pane via the sidebar Activity button (title="Activity").
   * Waits for the Live/Digest tab bar to become visible as confirmation.
   */
  async openActivityFeed() {
    // Activity moved from a standalone header button into the "Settings &
    // Tools" (Topics ▾) dropdown and is gated on `openclawAvailable` (stubbed
    // in mockActivityStream). Open the menu, click the "Activity" row, then
    // wait for the Live/Digest tab bar to confirm the pane rendered.
    await openTopicsMenuItem(this.page, "Activity");
    await this.liveFeedTab.waitFor({ state: "visible", timeout: 10_000 });
  }

  // --- Activity Feed Locators ---

  /** Activity feed container: uses data-testid if present, falls back to panel with Live/Digest tabs */
  get activityFeed() {
    // The data-testid is the ideal selector; fall back to the pane containing Live/Digest tabs
    return this.page.locator('[data-testid="activity-feed"]').or(
      this.page.locator('.flex.flex-col.h-full.relative:has(button:text("Live")):has(button:text("Digest"))'),
    );
  }

  get liveFeedTab() {
    return this.activityFeed.getByRole("button", { name: "Live" });
  }

  get digestTab() {
    return this.activityFeed.getByRole("button", { name: "Digest" });
  }

  // --- Journal Locators ---

  // --- Journal Locators (scoped from page since data-testid may not be on running server) ---

  get journalPrevDay() {
    return this.page.locator('button[title="Previous day"]');
  }

  get journalNextDay() {
    return this.page.locator('button[title="Next day"]');
  }

  get journalTodayButton() {
    return this.page.locator('button[title="Go to today"]');
  }

  get journalEventsTab() {
    return this.page.getByRole("button", { name: /Events \(/ });
  }

  // --- SSE Mock for Activity Feed ---

  /**
   * Mock the /api/activity/stream SSE endpoint with deterministic events.
   * Returns an init payload containing the provided events.
   * Must be called BEFORE navigation.
   */
  async mockActivityStream(
    events: Array<{
      id: string;
      timestamp: string;
      category: string;
      level: string;
      title: string;
    }>,
  ) {
    // The Activity feed (and its Journal "Digest" tab) is an OpenClaw-gated
    // surface — its Topics-menu entry only renders when openclaw is available.
    await mockOpenClawAvailable(this.page);

    await this.page.route("**/api/activity/stream", async (route) => {
      const body = `data: ${JSON.stringify({ type: "init", events })}\n\n`;
      await route.fulfill({
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
        body,
      });
    });
  }

  // --- Journal REST Mocks ---

  /**
   * Mock journal REST endpoints with deterministic data.
   * Must be called BEFORE navigation.
   */
  async mockJournalEndpoints(opts: {
    events?: Array<{
      id: string;
      timestamp: string;
      type: string;
      summary: string;
    }>;
    digest?: string | null;
  }) {
    await this.page.route("**/api/journal/events*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ events: opts.events || [] }),
      });
    });
    await this.page.route("**/api/journal/digest*", async (route) => {
      // Don't intercept the generate endpoint
      if (route.request().url().includes("/digest/generate")) {
        return route.fallback();
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          digest: opts.digest || null,
          exists: !!opts.digest,
        }),
      });
    });
  }

  // --- API Mock Helpers ---

  async mockKpiEndpoint(
    kpis: Record<string, number> = MOCK_KPIS,
  ) {
    await this.page.route("**/api/dashboard/kpis", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(kpis),
      });
    });
  }

  async mockTimeseriesEndpoint(
    pointsByRange: Record<
      string,
      Array<{ date: string; value: number }>
    > = MOCK_TIMESERIES,
  ) {
    await this.page.route("**/api/dashboard/timeseries*", async (route) => {
      const url = new URL(route.request().url());
      const range = url.searchParams.get("range") || "7d";
      const points = pointsByRange[range] || pointsByRange["7d"] || [];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ points }),
      });
    });
  }

  async mockAgentStatsEndpoint(
    agents: Array<{
      agentId: string;
      agentName: string;
      avatarEmoji: string;
      tasksCompleted: number;
      totalTokens: number;
      avgCycleTimeHours: number;
      errorRate: number;
      sessionsCount: number;
    }> = MOCK_AGENTS,
  ) {
    await this.page.route("**/api/dashboard/agent-stats", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ agents }),
      });
    });
  }

  /**
   * Mock all three dashboard API endpoints with deterministic data.
   * Call BEFORE navigation to ensure mocks are active on first load.
   */
  async mockAllDashboardEndpoints() {
    await this.mockKpiEndpoint();
    await this.mockTimeseriesEndpoint();
    await this.mockAgentStatsEndpoint();
  }
}

export const test = base.extend<{ dashboardPage: DashboardPage }>({
  dashboardPage: async ({ page }, use) => {
    await use(new DashboardPage(page));
  },
});
