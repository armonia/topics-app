import { expect, test } from "@playwright/test";
import { goToApp } from "./helpers";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/**
 * The status bar moved INTO the «Topics» menu, and what stayed outside.
 *
 * Asked for on 2026-08-31: «it has to go inside the topics dropdown menu». It is
 * the same place the phone has had it since 07/08, so the two populations stop
 * carrying two different maps of the same app.
 *
 * The cut is not "everything inside". An ALARM is not a statistic: how much
 * memory you are using is something you look at when you go looking for it, but
 * "you are offline" behind a gesture means the app is disconnected and whoever
 * is watching does not know until they open a menu. So one lamp stays in the
 * title row — and it stays in the DOM at all times, because half the suite uses
 * that testid to know the app is up, and a handle that exists only when things
 * go wrong is a handle that never exists.
 *
 * The identity band did NOT travel with it, and that is the deliberate half.
 * Its contract is responsive — the three subjects hold one line at sidebar
 * widths 180, 256 and 400 (CHIPS-01) — and the desktop dropdown has a width of
 * its own that does not follow the column: moving the band in would not have
 * relocated it, it would have deleted the contract it exists to satisfy. It is
 * also the half that sent the bar back to the foot on 07/08 — «where did the
 * accounts go?» — so leaving it there settles two things with one decision.
 *
 * @covers SIDEBAR-STATUS-01
 */
test.describe("Lo stato vive nel menu «Topics»", () => {
  test("la colonna non ha più una barra in fondo, e la spia è fuori", async ({ page }) => {
    await goToApp(page);

    // 1) NIENTE BARRA nella colonna. Non "invisibile": proprio assente.
    await expect(page.locator('[data-testid="sidebar-status-bar"]')).toHaveCount(0);

    // 2) LA SPIA C'È, a menu chiuso, ed è l'appiglio di prontezza che
    //    layout.fixture / multi-client / tab-sync usano da sempre.
    const spia = page.locator('[data-testid="connection-status"]');
    await expect(spia).toBeVisible({ timeout: 15_000 });
    // Ed è dentro la riga del titolo, non un residuo in fondo: si misura, non
    // si deduce — deve stare nella metà ALTA della colonna.
    const dove = await page.evaluate(() => {
      const s = document.querySelector('[data-testid="connection-status"]')!.getBoundingClientRect();
      const col = document.querySelector('[aria-label="Topics sidebar"]')!.getBoundingClientRect();
      return { spiaY: Math.round(s.y), metaColonna: Math.round(col.y + col.height / 2) };
    });
    expect(dove.spiaY, `la spia è a ${dove.spiaY}, la metà colonna a ${dove.metaColonna}`).toBeLessThan(dove.metaColonna);

    // 3) A TUTTO A POSTO NON GRIDA: nessun allarme dichiarato.
    await expect(spia).not.toHaveAttribute("data-alarm", "true");
  });

  test("aprendo il menu ci sono i numeri e la versione; l'identità resta in colonna", async ({ page }) => {
    await goToApp(page);
    await page.getByTestId("sidebar-topics-menu").click();

    // Lo stato è QUI dentro.
    await expect(page.locator('[data-testid="sidebar-status-bar"]')).toBeVisible({ timeout: 10_000 });
    // I numeri si leggono senza espandere il pannello (PERFPANEL-01).
    await expect(page.locator('[data-testid="metrics-total"]')).toBeVisible();
    // L'identità NO: è rimasta in fondo alla colonna, fuori dal menu, perché il
    // suo contratto è la larghezza della colonna (CHIPS-01) e il menu non la
    // segue. Si asserisce dove NON è e dove È: senza il secondo controllo
    // questa riga passerebbe anche se la fascia fosse sparita del tutto.
    const dentroIlMenu = page.locator('[data-testid="sidebar-system-menu"], [role="menu"]').locator('[data-testid="identity-row-me"]');
    await expect(dentroIlMenu).toHaveCount(0);
    await expect(page.locator('[data-testid="identity-row-me"]')).toBeVisible();
  });
});
