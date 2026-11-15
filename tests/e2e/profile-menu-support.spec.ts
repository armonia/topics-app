/**
 * SUPPORT AND COMMUNITY, one row in the user menu, one URL behind it.
 *
 * The row opens the project's Discord invite outside the app (a system tab on
 * the web build, `shell.openExternal` under Tauri — both routed through
 * `openExternalOnce`, so this spec watches for the popup the web build opens
 * and asserts its URL is the one configured in `lib/externalLinks.ts`, not a
 * copy of it: a second hardcoded string here would pass even if the row
 * stopped reading the shared constant.
 */
import { test, expect, type Page } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { goToApp } from "./helpers";
import { DISCORD_SUPPORT_INVITE_URL } from "../../client/src/lib/externalLinks";

hermetic(test);

async function openProfileMenu(page: Page) {
  const card = page.getByTestId("identity-me-profile");
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.click();
  const menu = page.getByTestId("profile-menu");
  await expect(menu).toBeVisible({ timeout: 10_000 });
  return menu;
}

test.describe("la voce di supporto nel menu utente", () => {
  test("apre l'invito Discord configurato in una finestra esterna", async ({ page }) => {
    await goToApp(page);
    const menu = await openProfileMenu(page);

    const row = menu.getByTestId("menu-support");
    await expect(row).toBeVisible();
    await expect(row).toHaveText(/./);

    const newWindow = page.waitForEvent("popup", { timeout: 10_000 });
    await row.click();
    const opened = await newWindow;
    expect(opened.url()).toBe(DISCORD_SUPPORT_INVITE_URL);
    await opened.close();
  });

  test("screenshot del menu a 375 e 1440px", async ({ page }) => {
    await goToApp(page);
    for (const width of [375, 1440] as const) {
      await page.setViewportSize({ width, height: 900 });
      const menu = await openProfileMenu(page);
      const row = menu.getByTestId("menu-support");
      await expect(row).toBeVisible();
      await page.screenshot({ path: `test-results/profile-menu-support/menu-${width}.png`, clip: await menu.boundingBox() ?? undefined });
      await page.keyboard.press("Escape");
    }
  });
});
