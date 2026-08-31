import { expect, type Page } from "@playwright/test";

/**
 * Opens the performance panel, through the gesture a person actually makes.
 *
 * It used to be one click on the status bar at the foot of the column. That bar
 * is gone from the desktop column since 2026-08-31 — its contents moved inside
 * the «Topics» menu, which is where the phone has had them since 07/08
 * (SIDEBAR-STATUS-01). So the gesture is now two steps, and eight call sites
 * across two specs were repeating both: hence this helper.
 *
 * `connection-status` did NOT come along: that testid stayed OUTSIDE, on the
 * lamp in the title row, because half the suite uses it to know the app is up
 * (layout.fixture, multi-client, tab-sync) and a handle behind a menu cannot
 * answer that question. The row that opens the panel is `menu-system-status`
 * — the dense strip that used to carry `status-bar-connection` is gone, and
 * the same three facts are rows now, on every screen.
 */
export async function openPerfPanel(page: Page): Promise<void> {
  await expect(page.locator('[aria-label="Topics sidebar"]').first()).toBeVisible({ timeout: 20_000 });
  const menu = page.getByTestId("sidebar-topics-menu");
  await expect(menu).toBeVisible({ timeout: 15_000 });
  await menu.click();
  const button = page.locator('[data-testid="menu-system-status"]');
  await expect(button).toBeVisible({ timeout: 15_000 });
  await button.click();
}
