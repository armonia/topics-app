import { test as base, type Page } from "@playwright/test";

export class SettingsPage {
  constructor(private page: Page) {}

  // --- Navigation ---

  /**
   * Open settings via the sidebar Settings & Tools dropdown -> Settings menu item.
   */
  async openSettings() {
    const topicsBtn = this.page.locator('button[title="Settings & Tools"]');
    await topicsBtn.click();

    const settingsBtn = this.page.locator(
      'button:has-text("Settings"):visible',
    );
    await settingsBtn.click();

    await this.panel.waitFor({ state: "visible", timeout: 10_000 });
  }

  // --- Mock Helpers ---

  /**
   * Mock ui-state endpoints for theme and settings.
   * Must be called BEFORE page.goto().
   */
  async mockUiStateEndpoints() {
    await this.page.route("**/api/ui-state/theme", async (route) => {
      const method = route.request().method();
      if (method === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify("system"),
        });
      } else if (method === "PUT") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
      } else {
        await route.fallback();
      }
    });

    await this.page.route("**/api/ui-state/settings", async (route) => {
      const method = route.request().method();
      if (method === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            theme: "system",
            fontSize: 13,
            messageDensity: "comfortable",
            sidebarWidth: 260,
          }),
        });
      } else if (method === "PUT") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
      } else {
        await route.fallback();
      }
    });
  }

  // --- Locator Getters ---

  get panel() {
    return this.page.locator('[data-testid="settings-panel"]');
  }

  get themeToggle() {
    return this.page.locator('[data-testid="settings-theme-toggle"]');
  }

  get themeButtons() {
    return this.panel.locator('button:has-text("Light"), button:has-text("Dark"), button:has-text("System")');
  }

  get fontSizeSlider() {
    return this.panel.locator('input[type="range"]');
  }

  get messageDensityButtons() {
    return this.panel.locator('button:has-text("Comfortable"), button:has-text("Compact")');
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
