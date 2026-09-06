import { expect, type Page } from "@playwright/test";
import { LAYOUT_MOBILE_WIDTH } from "../../../client/src/hooks/useMobile";

/**
 * THE ONE DOOR OF THE CHROME, opened through the gesture a person makes.
 *
 * On the desktop that door is the USER CARD at the foot of the column
 * (STATUSLINE-04, SIDEBAR-STATUS-01): the word «Topics» at the top stopped
 * being a menu when the five doors of the chrome (three chips at the foot, a
 * dropdown at the top) were folded into one. On the phone the column is a
 * drawer and the identity band does not exist, so the same rows still hang off
 * the title button there. Same rows, one component (`TopicsMenuItems` plus
 * `SidebarSystemMenu`), reached from two different triggers: this helper is
 * the only place that knows which trigger belongs to which screen, so a spec
 * asks for "the menu" and never for a testid that exists on one screen only.
 *
 * The split is decided on the VIEWPORT, which is the same signal the app
 * reads (`useMobile`, `LAYOUT_MOBILE_WIDTH`): a spec that runs under
 * `chromium-phone` or `chromium-touch` gets the phone door without naming it.
 *
 * Idempotent on purpose: a spec that already opened the menu must not toggle
 * it shut on the way in.
 */
export async function openProfileMenu(page: Page): Promise<void> {
  await expect(page.locator('[aria-label="Topics sidebar"]').first()).toBeVisible({ timeout: 20_000 });
  const rows = page.getByTestId("sidebar-system-menu");
  if ((await rows.count()) > 0) return;
  const width = page.viewportSize()?.width ?? Number.POSITIVE_INFINITY;
  const trigger = width < LAYOUT_MOBILE_WIDTH
    ? page.getByTestId("sidebar-topics-menu")
    : page.getByTestId("identity-me-profile");
  await expect(trigger).toBeVisible({ timeout: 15_000 });
  await trigger.click();
  await expect(rows).toBeVisible({ timeout: 15_000 });
}

/**
 * Opens the performance panel, through the gesture a person actually makes.
 *
 * It used to be one click on the status bar at the foot of the column. That bar
 * is gone from the desktop column since 2026-08-31 (SIDEBAR-STATUS-01): its
 * contents are rows inside the menu, and the row that opens the panel is
 * `menu-system-status`. So the gesture is two steps, open the menu and press
 * the row, and eight call sites across two specs were repeating both.
 *
 * `connection-status` did NOT come along: that testid stayed OUTSIDE, on the
 * dot of the user card, because half the suite uses it to know the app is up
 * (layout.fixture, multi-client, tab-sync) and a handle behind a menu cannot
 * answer that question.
 */
export async function openPerfPanel(page: Page): Promise<void> {
  await openProfileMenu(page);
  const button = page.locator('[data-testid="menu-system-status"]');
  await expect(button).toBeVisible({ timeout: 15_000 });
  await button.click();
  // AND THE POINTER LEAVES. The menu hangs off the card at the foot of the
  // column, so it grows UPWARD when the panel expands: the rows slide up under
  // a pointer that has not moved, and `TooltipDelegate` strips the `title` of
  // whatever lands under it. A spec that then reads those titles would find
  // one of them empty and blame the panel.
  await page.mouse.move(0, 0);
}
