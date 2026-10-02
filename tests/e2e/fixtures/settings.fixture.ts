import { test as base, type Page } from "@playwright/test";
import { closeProfileMenu, openProfileMenu } from "../helpers/open-perf-panel";
import { openUserMenuLevel } from "../helpers/user-menu";

export class SettingsPage {
  constructor(private page: Page) {}

  // --- Navigation ---

  /**
   * Open settings through the one door of the chrome: the user card on the
   * desktop, the title button on the phone (`openProfileMenu` picks). The
   * settings row is found by testid, not by its label: the label is
   * translated, and `TooltipDelegate` strips `title` attributes under the
   * pointer, so neither text nor `title` is a stable handle.
   */
  async openSettings() {
    await openProfileMenu(this.page);
    // One step again. The row was a LEVEL for a while (STATUSLINE-05), listing
    // the sections so «take me to the providers» was one gesture; 4763a62b took
    // that copy out - it repeated the panel's own navigation - so the row is
    // the plain door this fixture always wanted.
    await this.page.getByTestId("topics-menu-settings").click();
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
    // Solo il testid. Il ripiego sulle classi (`.bg-surface.rounded-xl.shadow-xl`)
    // era morto da f7ecd458, che ha portato MODAL_PANEL a `shadow-2xl`: un ramo
    // `.or()` che non può più agganciare nulla non è una rete di sicurezza, è
    // rumore che nasconde la deriva.
    return this.page.locator('[data-testid="settings-panel"]');
  }

  /**
   * Il velo del modale — è il PADRE del pannello (`MODAL_OVERLAY` in
   * client/src/lib/modalStyles.ts) ed è lui a portare l'`onClick={onClose}`.
   *
   * Ancorato al pannello e NON alle sue classi: il velo è passato da `z-50` a
   * `z-[10000]` in baff80a5 («Il menu "New" era unificato di sopra…», dove i
   * modali stavano sotto i popover a 9999), e ogni locator scritto sul numero
   * — `.fixed.inset-0.z-50` — è morto lì in silenzio.
   */
  get overlay() {
    return this.panel.locator("xpath=..");
  }

  /**
   * Chiude il pannello dal velo, come fa l'utente cliccando fuori.
   * L'angolo in alto a sinistra è sempre fuori dalla card (centrata,
   * max-w 760px / h 80vh).
   */
  async closeSettings() {
    await this.overlay.click({ position: { x: 10, y: 10 } });
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
