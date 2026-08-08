import { test as base, type Page } from "@playwright/test";
import { openAddMenuPane } from "../helpers/openclaw";

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

export class DashboardPage {
  constructor(private page: Page) {}

  // --- Navigation ---

  /**
   * Apre la pane Dashboard dal menu «New» (⌘N) della sidebar.
   *
   * Si chiamava «Statistics» e viveva nel dropdown «Settings & Tools»: era il
   * menu «+» con un'altra etichetta, e ora è una riga del «+» col nome che la
   * pane porta davvero nella tab e nella sidebar («Dashboard»).
   */
  async openDashboard() {
    await openAddMenuPane(this.page, "dashboard");

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

  /**
   * Mock every dashboard API endpoint with deterministic data.
   * Call BEFORE navigation to ensure mocks are active on first load.
   */
  async mockAllDashboardEndpoints() {
    await this.mockKpiEndpoint();
    await this.mockTimeseriesEndpoint();
  }
}

export const test = base.extend<{ dashboardPage: DashboardPage }>({
  dashboardPage: async ({ page }, use) => {
    await use(new DashboardPage(page));
  },
});
