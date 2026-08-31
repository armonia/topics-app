import { expect, type Page } from "@playwright/test";

/**
 * Brings the version chip within reach, through the gesture a person makes.
 *
 * It used to sit at the foot of the sidebar, always on screen. The status bar
 * moved into the «Topics» menu (SIDEBAR-STATUS-01) and the chip went with it, so
 * reaching it is now: open the menu, then the chip is there.
 *
 * Idempotent on purpose — a spec that already opened the menu must not toggle it
 * shut on the way in.
 */
export async function reachVersionChip(page: Page) {
  const menu = page.getByTestId("sidebar-topics-menu");
  await expect(menu).toBeVisible({ timeout: 15_000 });
  if ((await page.locator("[data-version-anchor]").count()) === 0) await menu.click();
  const chip = page.locator("[data-version-anchor]");
  await expect(chip).toBeVisible({ timeout: 15_000 });
  return chip;
}
