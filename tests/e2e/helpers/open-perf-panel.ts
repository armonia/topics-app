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
 * The panel is a LEVEL now, not an accordion under the row (STATUSLINE-05):
 * the row it hangs off is the same one, and it also carries the agents at
 * work: «who is running» and «what it costs» were two rows for one question.
 *
 * AND SINCE 4763a62b IT IS ONE BRANCH DEEPER. That level holds three doors -
 * what is RUNNING, what it has COST, what the MACHINE is doing - and the
 * numbers this helper is after live behind the first, `menu-system-performance`.
 * Before that card the running names and the megabytes sat flat at the top of
 * the level, the only subject without a door of its own next to «usage» and
 * «machine», which both had one.
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
  const status = page.getByTestId("menu-system-status-menu");
  await expect(status).toBeVisible({ timeout: 15_000 });
  const performance = status.getByTestId("menu-system-performance");
  await expect(performance).toBeVisible({ timeout: 15_000 });
  await performance.click();
  await expect(page.getByTestId("menu-system-performance-menu")).toBeVisible({ timeout: 15_000 });
  // AND THE POINTER LEAVES, which a level opened by a CLICK survives: it is
  // pinned until something explicit closes it. `TooltipDelegate` strips the
  // `title` of whatever sits under the pointer, so a spec reading those titles
  // would find one of them empty and blame the panel.
  await page.mouse.move(0, 0);
}

/**
 * SHUTS THE MENU, however many levels are open.
 *
 * One Escape closes the level under the pointer, not the whole menu: a spec
 * that opened a sub-level and then pressed Escape once was left with the menu
 * still over the column, and the click it made next went to the dismiss layer
 * instead of the row it aimed at. What that looks like from the outside is a
 * row that was clicked and did nothing.
 */
export async function closeProfileMenu(page: Page): Promise<void> {
  const rows = page.getByTestId("sidebar-system-menu");
  for (let i = 0; i < 4 && (await rows.count()) > 0; i++) {
    await page.keyboard.press("Escape");
    await expect(rows).toHaveCount(0, { timeout: 2_000 }).catch(() => {});
  }
  await expect(rows).toHaveCount(0, { timeout: 5_000 });
}

/**
 * WHAT THE COLUMN SHOWS, one level in.
 *
 * «Show archived» and the view mode were two flat rows of the menu and are now
 * inside the row that groups them by subject (`topics-menu-view`), which
 * carries the current state in its tail. Both are still one component, so this
 * is the gesture, and the specs address them by testid rather than by the label
 * they happen to have in the current view: `topics-menu-archived` and
 * `topics-menu-view-mode`.
 */
export async function openColumnViewMenu(page: Page): Promise<void> {
  await openProfileMenu(page);
  const row = page.locator('[data-testid="topics-menu-view"]');
  await expect(row).toBeVisible({ timeout: 15_000 });
  if ((await page.getByTestId("topics-menu-view-menu").count()) === 0) {
    await row.click();
  }
  await expect(page.getByTestId("topics-menu-view-menu")).toBeVisible({ timeout: 15_000 });
  await page.mouse.move(0, 0);
}

/**
 * ONE LEVEL FURTHER IN: the machine itself.
 *
 * The row that opens the work now answers two questions at two zooms — WHO is
 * running (the agent lines, plus the counts in its tail) and what the MACHINE
 * is doing (gateway, memory, the restart) — and the second went down a level of
 * its own rather than making the first one taller than the screen. So a spec
 * that reads a status row, the word «Gateway» or the restart button needs two
 * gestures, not one, and this is where that knowledge lives instead of in each
 * of them.
 *
 * `openPerfPanel` stops at the first level on purpose: the agents and the
 * per-section weights are there, and that is what `perf-panel` and
 * `feature-weight` read.
 */
export async function openMachinePanel(page: Page): Promise<void> {
  await openPerfPanel(page);
  const machine = page.locator('[data-testid="menu-system-machine"]');
  await expect(machine).toBeVisible({ timeout: 15_000 });
  await machine.click();
  await expect(page.getByTestId("menu-system-machine-menu")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("system-status-panel")).toBeVisible({ timeout: 15_000 });
  await page.mouse.move(0, 0);
}
