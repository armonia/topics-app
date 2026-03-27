import { test as base, type Page } from "@playwright/test";

export class SettingsPage {
  constructor(private page: Page) {}

  get panel() {
    return this.page.locator('[data-testid="settings-panel"]');
  }

  get themeToggle() {
    return this.page.locator('[data-testid="settings-theme-toggle"]');
  }

  async toggleTheme() {
    await this.themeToggle.click();
  }
}

export const test = base.extend<{ settingsPage: SettingsPage }>({
  settingsPage: async ({ page }, use) => {
    await use(new SettingsPage(page));
  },
});
