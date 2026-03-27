/**
 * Virtual scroll helpers for react-virtuoso lists in Playwright E2E tests.
 *
 * react-virtuoso only renders visible items in the DOM, so naive DOM count
 * assertions fail. These helpers scroll the container and collect items
 * as they appear.
 *
 * CONVENTION: No waitForTimeout() usage. Uses waitForFunction for render waits.
 */
import type { Page, Locator } from "@playwright/test";

export interface ScrollToFindOptions {
  /** Maximum number of scroll iterations before giving up (default: 30) */
  maxScrolls?: number;
  /** Pixels to scroll per iteration; defaults to container clientHeight */
  scrollIncrement?: number;
}

/**
 * Scroll a virtuoso container until an item matching the locator becomes visible.
 * Returns the locator once found, throws after maxScrolls if not found.
 */
export async function scrollToFind(
  page: Page,
  container: Locator,
  itemLocator: Locator,
  opts: ScrollToFindOptions = {}
): Promise<Locator> {
  const { maxScrolls = 30 } = opts;

  for (let i = 0; i < maxScrolls; i++) {
    if (await itemLocator.isVisible().catch(() => false)) return itemLocator;

    await container.evaluate(
      (el, increment) => {
        el.scrollTop += increment ?? el.clientHeight;
      },
      opts.scrollIncrement ?? null
    );

    // Wait for virtuoso to render new items
    await page
      .waitForFunction(() => document.readyState === "complete", null, {
        timeout: 2000,
      })
      .catch(() => {});
  }

  throw new Error(`Item not found after ${maxScrolls} scrolls`);
}

/**
 * Scroll through entire virtualized list, collecting unique items by data attribute.
 * Stops after 3 consecutive scrolls with no new items discovered.
 */
export async function scrollAndCollect(
  page: Page,
  container: Locator,
  itemSelector: string,
  identifierAttr: string = "data-id"
): Promise<Set<string>> {
  const seen = new Set<string>();
  let prevSize = -1;
  let stableCount = 0;

  while (stableCount < 3) {
    const items = await page.locator(itemSelector).all();
    for (const item of items) {
      const id =
        (await item.getAttribute(identifierAttr)) ||
        (await item.textContent());
      if (id) seen.add(id.trim());
    }

    if (seen.size === prevSize) {
      stableCount++;
    } else {
      stableCount = 0;
    }
    prevSize = seen.size;

    await container.evaluate((el) => {
      el.scrollTop += el.clientHeight;
    });

    // Brief wait for virtuoso render cycle
    await page
      .waitForFunction(() => document.readyState === "complete", null, {
        timeout: 1000,
      })
      .catch(() => {});
  }

  return seen;
}
