import { test as base, expect, devices } from "@playwright/test";
import { BrowserProcessPage } from "./fixtures/browser.fixture";
import { hermetic } from "./fixtures/hermetic";
import { CAL_CTX_ID, CAL_PANE_ID, CAL_URL, setPins, navigateToSidebar, calendarTile } from "./helpers/pinned-calendar-tile";

/**
 * @covers CAL-04
 *
 * THE TOUCH HALF of card 25775e23: on a device with no hover pointer, a tap
 * on the pinned calendar tile activates it directly -- the preview never
 * gets a chance to flash first (see `renderHoverPreview` gated on `hasHover`
 * in PinnedTiles.tsx). `test.use(devices[...])` has to be top-level in its
 * own file: Playwright refuses it inside a `describe` because it forces a
 * new worker.
 */
const test = base.extend<{ bp: BrowserProcessPage }>({
  bp: async ({ page }, use) => {
    await use(new BrowserProcessPage(page));
  },
});
hermetic(test);
test.use({ ...devices["Pixel 7"] });

test("a tap activates the pinned calendar tile directly, no preview flashes first", async ({ page, bp }) => {
  test.info().annotations.push({ type: "spec", description: "CAL-04" });
  await bp.mockBrowserContexts([
    { id: CAL_CTX_ID, url: CAL_URL, title: "Calendar", lastActivity: Date.now() },
  ]);
  await bp.mockRemoteBrowserPane({ connected: true, url: CAL_URL, title: "Calendar", hasScreenshot: true });
  await setPins(page, [CAL_PANE_ID]);
  await navigateToSidebar(page);
  const tile = calendarTile(page);
  await expect(tile).toBeVisible();
  await tile.tap();
  await expect(page.getByTestId("pinned-hover-preview")).toHaveCount(0);
  await expect(page.locator('[data-browser-pane]').first()).toBeVisible({ timeout: 10000 });
});
