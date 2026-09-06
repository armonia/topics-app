import { expect, type Page } from "@playwright/test";
import { openProfileMenu } from "./open-perf-panel";

/**
 * Brings the version chip within reach, through the gesture a person makes.
 *
 * It used to sit at the foot of the sidebar, always on screen. The status bar
 * moved behind the one door of the chrome (SIDEBAR-STATUS-01) and the chip
 * went with it, so reaching it is now: open the menu, then the chip is there.
 * Which trigger opens that menu (the user card on the desktop, the title on
 * the phone) is `openProfileMenu`'s business, not this file's.
 *
 * Idempotent on purpose: a spec that already opened the menu must not toggle it
 * shut on the way in.
 */
export async function reachVersionChip(page: Page) {
  if ((await page.locator("[data-version-anchor]").count()) === 0) await openProfileMenu(page);
  const chip = page.locator("[data-version-anchor]");
  await expect(chip).toBeVisible({ timeout: 15_000 });
  return chip;
}
