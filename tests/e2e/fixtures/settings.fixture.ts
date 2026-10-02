import { test as base, type Page } from "@playwright/test";
import { closeProfileMenu } from "../helpers/open-perf-panel";
import { openUserMenuLevel } from "../helpers/user-menu";

export class SettingsPage {
  constructor(private page: Page) {}

  // --- Navigation ---

  /**
   * Open the settings: every setting is a level of the user menu since
   * `menu-utente-tutto`, and the forms land on AI providers, the first one a
   * person comes for. The user card on the desktop, the title button on the
   * phone (`openUserMenuLevel` picks). Rows are found by testid, never by their
   * translated label.
   */
  async openSettings() {
    await openUserMenuLevel(this.page, "providers");
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

  /** The AI providers level of the user menu. */
  get panel() {
    return this.page.getByTestId("topics-menu-providers-menu");
  }

  /** Closes the user menu, the level first: one Escape per level. */
  async closeSettings() {
    await closeProfileMenu(this.page);
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

  /** The text size, a spinbutton: arrows move it one step. */
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
