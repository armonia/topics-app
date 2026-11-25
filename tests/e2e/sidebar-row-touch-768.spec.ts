/**
 * Sidebar rows answer to a 44px target under a finger at 375 and at 768
 * (card 5df83d1f). 768 is `md:`, where rows used to drop to 34px.
 *
 * @covers SIDETOUCH-01
 */
import { test, expect } from "@playwright/test";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

test.use({ hasTouch: true, isMobile: true });

for (const width of [375, 768]) {
  test(`pinned tiles and rows are at least 44px tall at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(E2E_BASE);
    // The Automations row is always drawn, so wait for it instead of reading
    // the DOM before the sidebar has rendered, then for a measurable row.
    await page.getByTestId("sidebar-automations").waitFor();
    await expect(page.locator('[class*="coarse:h-11"]').first()).toBeVisible({ timeout: 30_000 });
    const heights = await page.evaluate(() => {
      const out: number[] = [];
      for (const el of Array.from(document.querySelectorAll<HTMLElement>('[class*="coarse:h-11"]'))) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) out.push(Math.round(r.height));
      }
      return out;
    });
    expect(heights.length, "the page must draw rows to measure").toBeGreaterThan(0);
    expect(heights.filter((h) => h < 44)).toEqual([]);
  });
}
