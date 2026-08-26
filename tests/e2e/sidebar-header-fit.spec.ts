/**
 * @covers LAYOUT-01
 *
 * The top row of the sidebar has to HOLD what it shows, on every platform.
 *
 * It did not: where the primary modifier is Ctrl the shortcut hints are wider
 * ("Ctrl+K" against "⌘K"), the row ran 37px short, and the notification bell was
 * pushed out of its own group and underneath the one on `z-50` — still visible,
 * still "enabled and stable" to Playwright, and no longer clickable. Twelve
 * `notification-history` cases timed out on Linux CI for this, with the pointer
 * intercepted by the magnifier's `<circle>`.
 *
 * The platform is faked rather than waited for: `usesCtrl` reads
 * `navigator.platform` / `userAgentData.platform`, so a Mac can run the Windows
 * and Linux case too — which is the whole point, since nobody has one of those
 * open while writing this.
 */
import { test, expect } from "@playwright/test";
import { goToApp } from "./helpers";

for (const [nome, platform] of [["Mac", "MacIntel"], ["non-Mac", "Linux x86_64"]] as const) {
  test(`SIDEBAR-FIT: su ${nome} la campanella resta cliccabile`, async ({ page }) => {
    await page.addInitScript((p) => {
      Object.defineProperty(navigator, "platform", { get: () => p });
      Object.defineProperty(navigator, "userAgentData", {
        get: () => ({ platform: p === "MacIntel" ? "macOS" : "Linux" }),
      });
    }, platform);
    await goToApp(page);

    const misura = await page.evaluate(() => {
      const b = document.querySelector('[data-testid="notification-history-button"]') as HTMLElement | null;
      if (!b) return null;
      const r = b.getBoundingClientRect();
      const gruppo = b.parentElement!.getBoundingClientRect();
      const sopra = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { sporge: Math.round(r.right - gruppo.right), riceveIlClick: b.contains(sopra) };
    });
    expect(misura, "la campanella deve esistere nella riga").not.toBeNull();

    // Il click arriva al bottone e non a cio' che gli sta sopra: e' la
    // proprieta' che serve, e la sola che un utente noterebbe.
    expect(misura!.riceveIlClick, "qualcosa copre la campanella").toBe(true);
    // E non sporge dal gruppo che la contiene: e' la CAUSA, e tenerla misurata
    // fa fallire il test dove il difetto nasce invece che dove si vede.
    expect(misura!.sporge, "la campanella esce dal suo gruppo").toBeLessThanOrEqual(0);

    // La prova finale e' il gesto: se il pannello si apre, il click e' passato.
    await page.getByTestId("notification-history-button").click({ timeout: 8_000 });
    await expect(page.getByTestId("notification-history-panel")).toBeVisible({ timeout: 8_000 });
  });
}
