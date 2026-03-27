import { test as base, type Page } from "@playwright/test";

export class DashboardPage {
  constructor(private page: Page) {}

  get kpiCards() {
    return this.page.locator('[data-testid="dashboard-kpi-cards"]');
  }

  get chart() {
    return this.page.locator('[data-testid="dashboard-chart"]');
  }
}

export const test = base.extend<{ dashboardPage: DashboardPage }>({
  dashboardPage: async ({ page }, use) => {
    await use(new DashboardPage(page));
  },
});
