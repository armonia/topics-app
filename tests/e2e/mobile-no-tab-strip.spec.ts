/**
 * ON THE PHONE THE TABS ARE NOT DRAWN TWICE.
 *
 * Below 768px the topics column is full screen and already lists the open
 * surfaces, so the strip on top repeated that list and took 46px of the 844px
 * screen (card b8ca85e8). Only the PROJECT strip stays: it is the sole list of
 * that project's panes, and the column does not enumerate them. Its guard is
 * `project-tabs.spec.ts` PROJECT-TABS-MOBILE-01.
 *
 * NOSTRIP-01  no strip on screen, and the NAME of the current surface is read instead
 * NOSTRIP-02  switching surface stays possible FROM THE LIST
 * NOSTRIP-03  the same holds with the board in front
 */
import { test, expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const BASE = E2E_BASE;
const TAB_STRIP = '[data-testid="panel-tab-bar"]';
const PANE_TITLE = '[data-testid="mobile-pane-title"]';
const BOARD = '[data-testid="mobile-chrome-board"]';
const DRAWER_TOGGLE = '[aria-label="Toggle sidebar"]';

let alpha: { id: string; name: string };
let beta: { id: string; name: string };

test.beforeAll(async ({ request }) => {
  alpha = await createTopic(request, "Alpha phone");
  beta = await createTopic(request, "Beta phone");
  // Two panes in the SAME group: the configuration that used to produce a
  // two-tab strip. With a single pane the test could not tell "no strip" from
  // "nothing to list".
  await resetPaneStore(request, [alpha.id, beta.id]);
});

test.afterAll(async ({ request }) => {
  await resetPaneStore(request, []);
  await deleteTopic(request, alpha.id).catch(() => {});
  await deleteTopic(request, beta.id).catch(() => {});
});

/** Opens the app with the drawer COLLAPSED, the state a phone surface is read in
 *  and the only one where the strip would be visible. The wait anchor is the
 *  bottom row, not the pane title: the title is new, and waiting on it would
 *  fail the test on the anchor instead of on the strip. */
async function openApp(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try { localStorage.setItem("topics-mobile-drawer-collapsed", "1"); } catch { /* private mode */ }
  });
  await page.goto(BASE);
  await expect(page.locator('[data-testid="mobile-chrome-bar"]')).toBeVisible({ timeout: 15000 });
  await expect(page.locator(DRAWER_TOGGLE).first()).toBeVisible({ timeout: 15000 });
}

test.describe.serial("The phone, without the tab strip", () => {
  test("NOSTRIP-01: no strip on screen, and the surface name in its place", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "NOSTRIP-01" });
    await openApp(page);

    // `:visible`, not the bare count: inactive panes stay mounted behind their
    // `display:none` shell (keep-alive), and counting them would measure the
    // DOM instead of the screen.
    await expect(page.locator(`${TAB_STRIP}:visible`)).toHaveCount(0);

    // Without the name, one surface on screen and no list on top would not say
    // which one you are looking at.
    await expect(page.locator(PANE_TITLE).first()).toHaveText(alpha.name);

    // The way back to the list is visible, not a gesture to guess.
    await expect(page.locator(DRAWER_TOGGLE).first()).toBeVisible();
  });

  test("NOSTRIP-02: the surface is switched from the list", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "NOSTRIP-02" });
    await openApp(page);
    await expect(page.locator(PANE_TITLE).first()).toHaveText(alpha.name);

    await page.locator(DRAWER_TOGGLE).first().click();
    // The topic row has no data-topic-id: it is found by name inside the column.
    const row = page.getByTestId("sidebar-topic-list").getByText(beta.name).first();
    await expect(row).toBeVisible({ timeout: 10000 });
    await row.click();

    await expect(page.locator(PANE_TITLE).first()).toHaveText(beta.name, { timeout: 10000 });
    // Navigating did not bring a strip back.
    await expect(page.locator(`${TAB_STRIP}:visible`)).toHaveCount(0);
  });

  test("NOSTRIP-03: the board carries no strip either", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "NOSTRIP-03" });
    await openApp(page);

    await page.locator(BOARD).first().click();
    await expect(page.locator('[data-testid="kanban-board"]').first())
      .toBeVisible({ timeout: 15000 });

    await expect(page.locator(`${TAB_STRIP}:visible`)).toHaveCount(0);
  });
});
