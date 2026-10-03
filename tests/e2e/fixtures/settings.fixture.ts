import { test as base, type Page } from "@playwright/test";
import { closeProfileMenu } from "../helpers/open-perf-panel";
import { openHomePanel, openUserMenuLevel } from "../helpers/user-menu";

export class SettingsPage {
  constructor(private page: Page) {}

  // --- Navigation ---

  /**
   * Open the AI providers, the form a person comes for first. Since the
   * 03/10/2026 change it lives where it is used, beside the model selector,
   * and one host draws it (`openHomePanel`, SETHOME-01).
   */
  async openSettings() {
    await openHomePanel(this.page, "providers");
    await this.page.getByTestId("ai-providers-settings").waitFor({ state: "visible", timeout: 15_000 });
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

  /** The AI providers panel. */
  get panel() {
    return this.page.getByTestId("home-panel-providers");
  }

  /** Closes the providers panel: one Escape. */
  async closeSettings() {
    await this.page.keyboard.press("Escape");
    await this.panel.waitFor({ state: "hidden", timeout: 10_000 });
  }

  // --- The appearance controls, which live in the user menu now ---

  /**
   * Opens the user menu's Appearance level: theme, text size, chat width and
   * density moved there from the panel (`sidebar-menu-settings`), as direct
   * controls applied on change. Hands back the level.
   */
  async openAppearance() {
    return openUserMenuLevel(this.page, "appearance");
  }

  /** Closes the user menu, one level per Escape. */
  async closeMenu() {
    await closeProfileMenu(this.page);
  }

  themeRadio(mode: "light" | "dark" | "system") {
    return this.page.getByTestId(`appearance-theme-${mode}`);
  }

  densityRadio(density: "compact" | "comfortable") {
    return this.page.getByTestId(`appearance-density-${density}`);
  }

  /** The text size, a spinbutton: right and left move it one step. */
  get fontSizeStepper() {
    return this.page.getByTestId("appearance-font-size");
  }

  /** The other stepper of the level: the ceiling of the chat column. */
  get chatWidthStepper() {
    return this.page.getByTestId("appearance-chat-width");
  }
}

export const test = base.extend<{ settingsPage: SettingsPage }>({
  settingsPage: async ({ page }, use) => {
    await use(new SettingsPage(page));
  },
});
