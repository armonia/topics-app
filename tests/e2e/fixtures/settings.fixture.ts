import { test as base, type Page } from "@playwright/test";

export class SettingsPage {
  constructor(private page: Page) {}

  // --- Navigation ---

  /**
   * Open settings via the sidebar Settings & Tools dropdown -> Settings menu item.
   */
  async openSettings() {
    /* Anchored on the testid, NOT on `title="Settings & Tools"`.
     *
     * `TooltipDelegate` (ec40c0932) strips `title` on `mouseover` and only
     * restores it on `mouseout`. `closeSettings()` dismisses the veil by
     * clicking (10, 10) — the viewport's top-left, which is where this very
     * button sits — so after the click, and across the `page.reload()` that
     * follows (Playwright does not move the pointer), the trigger is under the
     * mouse with no `title` at all. That is why SET-03 only ever died on its
     * SECOND `openSettings`, never the first.
     *
     * `App.tsx` already documents this testid as the stable anchor, for the
     * separate reason that the button's accessible name is "Topics". */
    const topicsBtn = this.page.getByTestId("sidebar-topics-menu");
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

  get themeButtons() {
    return this.panel.locator('button:has-text("Light"), button:has-text("Dark"), button:has-text("System")');
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

  /**
   * Dal 27ccc796 («…la misura di lettura») il pannello ha DUE `input[type=range]`:
   * corpo del testo e "Larghezza chat". Si punta quello giusto per il suo nome,
   * non per posizione — `.first()` seguirebbe l'ordine visivo della sezione.
   */
  get fontSizeSlider() {
    return this.panel.getByRole("slider", { name: "Font Size" });
  }

  /** L'altro cursore della sezione Aspetto: il tetto della colonna di chat. */
  get chatWidthSlider() {
    return this.panel.getByRole("slider", {
      name: "Larghezza massima della colonna di chat",
    });
  }

  get messageDensityButtons() {
    return this.panel.locator('button:has-text("Comfortable"), button:has-text("Compact")');
  }
}

export const test = base.extend<{ settingsPage: SettingsPage }>({
  settingsPage: async ({ page }, use) => {
    await use(new SettingsPage(page));
  },
});
