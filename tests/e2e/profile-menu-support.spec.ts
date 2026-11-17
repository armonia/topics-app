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
import { openProfileMenu } from "./helpers/open-perf-panel";
import { DISCORD_SUPPORT_INVITE_URL } from "../../client/src/lib/externalLinks";

hermetic(test);

test.describe("la voce di supporto nel menu utente", () => {
  test("apre l'invito Discord configurato in una finestra esterna", async ({ page }, testInfo) => {
    testInfo.annotations.push({ type: "spec", description: "USERMENU-11" });
    await goToApp(page);
    // The invite host redirects to another domain; stub it so the popup keeps
    // the URL the row opened instead of the redirect target.
    await page.context().route("https://discord.gg/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<html></html>" }));
    await openProfileMenu(page);

    const row = page.getByTestId("menu-support");
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
      // Below the desktop breakpoint the sidebar is a drawer, closed by default.
      const sidebar = page.locator('[aria-label="Topics sidebar"]').first();
      if (width < 800 && (await sidebar.getAttribute("data-drawer")) === "closed") await page.keyboard.press("ControlOrMeta+b");
      await openProfileMenu(page);
      const row = page.getByTestId("menu-support");
      await expect(row).toBeVisible();
      await page.screenshot({ path: `test-results/profile-menu-support/menu-${width}.png` });
      await page.keyboard.press("Escape");
    }
  });
});
