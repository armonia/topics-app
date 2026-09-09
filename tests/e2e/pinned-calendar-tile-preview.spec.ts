import { test as base, expect } from "@playwright/test";
import { BrowserProcessPage } from "./fixtures/browser.fixture";
import { hermetic } from "./fixtures/hermetic";
import { CAL_CTX_ID, CAL_PANE_ID, CAL_URL, setPins, gotoSidebar, calendarTile } from "./helpers/pinned-calendar-tile";

/**
 * @covers CAL-04
 *
 * THE PINNED CALENDAR TILE PREVIEWS ON HOVER/FOCUS, NOT ON CLICK (card 25775e23).
 *
 * A pinned calendar page used to expand a click-toggled band under its row
 * (`CalendarAgendaBand`, fed by the ICS feed from Settings). It now shows a
 * small screenshot of the browser pane ALREADY open for that pin -- hovering
 * or focusing the tile, never a new browser and never the ICS feed -- and a
 * click keeps doing what every other pinned tile's click does: activate the
 * pane. Touch has no hover, so a tap just activates directly (see the
 * `-touch` counterpart of this spec).
 *
 * The screenshot itself is mocked at the wire (`/api/browsers/:id/snapshot`,
 * same route `useRemoteBrowser`'s own live preview already uses): this spec
 * proves the TRIGGER (hover, focus, leave, blur, click) picks the right
 * content, not that a real Chromium pane renders a pixel-perfect calendar.
 */

const test = base.extend<{ bp: BrowserProcessPage }>({
  bp: async ({ page }, use) => {
    await use(new BrowserProcessPage(page));
  },
});
hermetic(test);

test.describe("Pinned calendar tile — hover/focus preview", () => {
  test.beforeEach(async ({ bp, page }) => {
    await bp.mockBrowserContexts([
      { id: CAL_CTX_ID, url: CAL_URL, title: "Calendar", lastActivity: Date.now() },
    ]);
    await bp.mockRemoteBrowserPane({ connected: true, url: CAL_URL, title: "Calendar", hasScreenshot: true });
    await setPins(page, [CAL_PANE_ID]);
  });

  test("hovering the tile shows the screenshot preview, leaving hides it", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "CAL-04" });
    await gotoSidebar(page);
    const tile = calendarTile(page);
    await expect(tile).toBeVisible();

    await expect(page.getByTestId("pinned-hover-preview")).toHaveCount(0);
    await tile.hover();
    const preview = page.getByTestId("pinned-hover-preview");
    await expect(preview).toBeVisible({ timeout: 3000 });
    await expect(preview.getByTestId("calendar-tile-preview-image")).toBeVisible();

    // Moving away unmounts it -- which is also what stops the fetch it fired.
    await page.mouse.move(5, 5);
    await expect(page.getByTestId("pinned-hover-preview")).toHaveCount(0);
  });

  test("focusing the tile shows the preview, blurring hides it", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "CAL-04" });
    await gotoSidebar(page);
    const tile = calendarTile(page);
    await expect(tile).toBeVisible();
    await tile.focus();
    await expect(page.getByTestId("pinned-hover-preview")).toBeVisible({ timeout: 3000 });
    await tile.blur();
    await expect(page.getByTestId("pinned-hover-preview")).toHaveCount(0);
  });

  test("clicking the tile still activates it, popover or not", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "CAL-04" });
    await gotoSidebar(page);
    const tile = calendarTile(page);
    await expect(tile).toBeVisible();
    await tile.click();
    // Activation opens the browser pane for that pin -- its toolbar shows up.
    await expect(page.locator('[data-browser-pane]').first()).toBeVisible({ timeout: 10000 });
  });
});
