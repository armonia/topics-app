/**
 * THE NEGATIVE THAT CAN STILL FAIL: "no address row above the page".
 *
 * It used to be written as `browser-url-input → count 0`, and since
 * `BrowserToolbar` was deleted that testid exists nowhere: the assertion passes
 * over any app, including one that grows a new strip tomorrow under another
 * name. HERO-R-003, in one line, and it was still in thirteen places across
 * three specs after the file that first named it had moved on.
 *
 * So it is measured as GEOMETRY, which is what the requirement is actually
 * about (the "no address row, ever" scenario of `TOPIC-BROWSER-02`): the page area
 * of a browser pane starts at the pane's own top edge. A chrome strip of any
 * name, any testid, pushes it down and this goes red. The find bar is the one
 * admitted exception and it is a MODE - it exists only while you are
 * searching - so a scene that is not searching must not see it.
 *
 * The page area is the frame slot (iframe path) or the native slot (desktop
 * shell); on the streaming path it is the pane's last flex child, the
 * screenshot viewer.
 */
import { expect, type Page } from "@playwright/test";

/** How far below its pane's top edge the first browser pane's page area
 *  starts, once that distance has stopped changing for `quietMs`. */
export async function settledGapAboveThePage(page: Page, quietMs: number): Promise<number> {
  const handle = await page.waitForFunction(
    (quiet) => {
      const w = window as unknown as { __pageGapSeen?: number; __pageGapSince?: number };
      const pane = document.querySelector("[data-browser-pane]");
      const area = pane?.querySelector("[data-browser-frame-slot], [data-native-browser-slot]")
        ?? pane?.lastElementChild;
      // No pane mounted (yet) is not a distance: keep waiting instead of
      // settling on a sentinel that would read as "no row".
      if (!pane || !area) {
        w.__pageGapSeen = undefined;
        return null;
      }
      const gap = Math.round(area.getBoundingClientRect().top - pane.getBoundingClientRect().top);
      const now = performance.now();
      if (w.__pageGapSeen !== gap) {
        w.__pageGapSeen = gap;
        w.__pageGapSince = now;
        return null;
      }
      // An OBJECT, not the number: `waitForFunction` reads the return value as
      // "am I done?", and a settled gap of zero - the good case - is falsy.
      return now - (w.__pageGapSince ?? now) >= quiet ? { gap } : null;
    },
    quietMs,
    { timeout: 30_000, polling: "raf" },
  );
  // `waitForFunction` only resolves on a truthy value; the fallback names the
  // impossible case with a gap no pane can have, so it fails loudly.
  const settled = (await handle.jsonValue()) ?? { gap: Number.POSITIVE_INFINITY };
  await page.evaluate(() => {
    const w = window as unknown as { __pageGapSeen?: number; __pageGapSince?: number };
    delete w.__pageGapSeen;
    delete w.__pageGapSince;
  });
  return settled.gap;
}

/** The page area starts at the pane's top edge right now (one stable frame). */
export async function expectNoRowAboveThePage(page: Page, why: string): Promise<void> {
  expect(await settledGapAboveThePage(page, 0), why).toBeLessThanOrEqual(1);
}

/**
 * No row comes back ON ITS OWN: the gap is measured once it has been still for
 * `quietMs`. A row that reappears restarts the quiet period and is then read as
 * present, which is the failure this exists to catch; a clean run stops as soon
 * as it is quiet, instead of sleeping a fixed window.
 */
export async function expectNoRowComesBack(page: Page, why: string, quietMs = 2_000): Promise<void> {
  expect(await settledGapAboveThePage(page, quietMs), why).toBeLessThanOrEqual(1);
}
