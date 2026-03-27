import { test as base, type Page } from "@playwright/test";

export class LayoutPage {
  constructor(private page: Page) {}

  get tabBar() {
    return this.page.locator('[data-testid="panel-tab-bar"]');
  }

  get connectionStatus() {
    return this.page.locator('[data-testid="connection-status"]');
  }

  get mainContent() {
    return this.page.locator('[role="main"]');
  }

  async toggleSidebar() {
    await this.page.keyboard.press("Meta+b");
  }
}

export const test = base.extend<{ layoutPage: LayoutPage }>({
  layoutPage: async ({ page }, use) => {
    await use(new LayoutPage(page));
  },
});
