/**
 * ON THE PHONE THE LIST IS NOT UNDER THE PAGE OF A BROWSER TAB.
 *
 * A browser tab's page lives in one fixed layer appended to `document.body`
 * (`Browser/hostedIframe.ts`), at z-index 1, and its pane only lends it a
 * rectangle. The app's own root is `position: fixed`, which makes it a stacking
 * context of its own at z-index auto: everything drawn inside it, the phone's
 * list drawer at `z-50` included, paints UNDER that layer. The overlays that
 * win against it are the ones portaled to `body` (menus, sheets, dialogs).
 *
 * So on the phone, with a browser tab open behind the list, the page covered
 * the whole list from the top row to the button row, and with it the notice
 * «bundle rebuilt» docked at the bottom of the list: its Reload and its close
 * were under the page. Found by `usability-audit.spec.ts` (phone, «sidebar and
 * the bundle banner»), red at the first attempt of every run since 07/10: its
 * desktop browser group leaves a browser tab open, and the phone group after
 * it opens the list over that tab. Green at the retry only because the retry
 * runs the file's hooks again, and `hermetic` puts the pane store back to a
 * baseline without the tab.
 *
 * This file opens the tab the way that group leaves it, then opens the list on
 * the phone and asks the screen who answers a tap: a row of the list, the
 * banner's Reload, the banner's close. And it waits for the page to be
 * PLACED first: a frame that never arrived covers nothing, and the test would
 * be green for free. Then it closes the list and asks the opposite: the
 * page must be back over its pane. Last, the gesture a person makes from
 * there: the list opened again over a page that is already on screen.
 *
 * @covers TOPIC-BROWSER-03 UI-READ-01
 */
import { test, expect, type Page, type Locator } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { resetPaneStore } from "./helpers/api-fixtures";

hermetic(test);

/** What answers a tap at the centre of `target`: the element itself (or one
 *  of its children), or the testid / tag of whatever is in front of it. */
async function answerAtCenter(page: Page, target: Locator): Promise<string> {
  const box = await target.boundingBox();
  expect(box, "the target has a box").not.toBeNull();
  return target.evaluate((el, { x, y }) => {
    const hit = document.elementFromPoint(x, y);
    if (hit && (hit === el || el.contains(hit))) return "itself";
    return hit?.getAttribute("data-testid") ?? hit?.tagName ?? "nothing";
  }, { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 });
}

/** Who answers a tap in the middle of the screen: "the list", or the testid /
 *  tag of whatever is in front of it. */
async function middleAnswer(page: Page): Promise<string> {
  return page.evaluate(() => {
    const hit = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    return hit?.closest('[aria-label="Topics sidebar"]') ? "the list" : (hit?.getAttribute("data-testid") ?? hit?.tagName ?? "nothing");
  });
}

/** The page has been given a rectangle: its wrapper carries `data-at`. */
async function framePlaced(page: Page): Promise<void> {
  await expect.poll(
    () => page.evaluate(() => document.querySelector<HTMLElement>("[data-browser-frame-for]")?.dataset.at ?? ""),
    { timeout: 20_000, message: "the browser tab's page is placed over its pane" },
  ).not.toBe("");
}

test.describe.serial("a browser tab behind the phone's list", () => {
  test.describe("desktop", () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test("a browser tab left open, as the usability audit's browser group leaves it", async ({ page }) => {
      // The same stubs as that group: the pane's chrome comes up, no page yet.
      await page.routeWebSocket(/\/ws\/browser\//, () => {});
      await page.route(/\/api\/browsers\//, (route) =>
        route.request().method() === "GET" ? route.fulfill({ status: 404, body: "Not found" }) : route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }));
      await resetPaneStore(page.request, []);
      await page.goto("/");
      await page.keyboard.press("Escape");
      await page.getByTestId("pane-add-menu-trigger").first().click();
      await page.getByTestId("pane-add-menu-browser").click();
      const pane = page.locator("[data-browser-pane]").first();
      await expect(pane).toBeVisible({ timeout: 10_000 });
      const address = pane.getByRole("textbox").first();
      await address.fill("example.com");
      await address.press("Enter");
      // The tab and its address must be in the server's pane store before this
      // page goes: the phone below reads them from there.
      await expect.poll(
        async () => (await page.request.get("/api/ui-state/pane-store-v2")).text(),
        { timeout: 10_000, message: "the browser tab and its address are saved" },
      ).toContain("example.com");
    });
  });

  test.describe("phone", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test("the list and the bundle banner answer their own taps, and the page comes back with its pane", async ({ page }) => {
      await page.goto("/");
      const list = page.locator('[aria-label="Topics sidebar"]').first();
      await expect(list).toBeVisible({ timeout: 20_000 });
      await expect(page.locator("[data-drawer]")).toHaveAttribute("data-drawer", "open");
      await framePlaced(page);

      // The middle of the screen, where the list is and the page was: the first
      // row sits above the page's rectangle (it starts under the 40px top row)
      // and would answer either way.
      expect(await middleAnswer(page), "the middle of the screen").toBe("the list");

      await page.evaluate(() => window.dispatchEvent(new CustomEvent("topics:bundle-stale")));
      const reload = page.getByTestId("bundle-stale-reload");
      const dismiss = page.getByTestId("update-banner-dismiss");
      await expect(reload).toBeVisible({ timeout: 5_000 });
      expect(await answerAtCenter(page, reload), "the banner's Reload").toBe("itself");
      expect(await answerAtCenter(page, dismiss), "the banner's close").toBe("itself");
      await dismiss.tap();
      await expect(page.getByTestId("bundle-stale-toast")).toHaveCount(0);

      // Closing the list: the browser tab is in front again, and so is its page.
      await list.getByText("Browser", { exact: true }).first().tap();
      await expect(page.locator("[data-drawer]")).toHaveAttribute("data-drawer", "closed");
      const slot = page.locator("[data-browser-pane]").first();
      await expect(slot).toBeVisible({ timeout: 10_000 });
      await expect.poll(async () => {
        const box = await slot.boundingBox();
        if (!box) return "no box";
        return page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.getAttribute("data-testid") ?? "other", { x: box.x + box.width / 2, y: box.y + box.height / 2 });
      }, { timeout: 5_000, message: "the page answers over its pane" }).toBe("browser-iframe");

      // And the gesture a person makes from there: the page is in front, the
      // list is opened over it. The frame already exists this time, so the
      // layer has to step aside while it is on screen, not only be born hidden.
      await page.getByTestId("sidebar-reopen").first().tap();
      await expect(page.locator("[data-drawer]")).toHaveAttribute("data-drawer", "open");
      await expect.poll(() => middleAnswer(page), { timeout: 5_000, message: "the middle of the screen, list reopened" }).toBe("the list");
    });
  });
});
