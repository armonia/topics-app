import { test as base, type Page } from "@playwright/test";

export class ContextPage {
  constructor(private page: Page) {}

  get inspector() {
    return this.page.locator('[data-testid="context-inspector"]');
  }

  get budgetBar() {
    return this.page.locator('[data-testid="context-budget-bar"]');
  }

  get contextPills() {
    return this.page.locator('[data-testid="context-pills"]');
  }
}

export const test = base.extend<{ contextPage: ContextPage }>({
  contextPage: async ({ page }, use) => {
    await use(new ContextPage(page));
  },
});
