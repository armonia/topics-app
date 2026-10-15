import { expect, test } from "@playwright/test";
import { goToApp } from "./helpers";
import { resetPaneStore } from "./helpers/api-fixtures";
import { hostNativePage, pageLayout } from "./helpers/native-host-page";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/** @covers BROWSER-DOM-NAV-EDGE-01 */
const HOST_SIZE = { width: 800, height: 600 };
const HOST_HTML = `<!doctype html><html><head><title>Edge swipe host</title></head>
  <body style="margin:0;width:2400px;font:16px sans-serif"><main id="swipe-content">${"<p>Hosted page</p>".repeat(120)}</main></body></html>`;

async function swipe(
  page: import("@playwright/test").Page,
  point: "left" | "right" | "center",
  direction: "left" | "right",
  verticalFirst = false,
): Promise<{ ready: string | null; arrowX: number | null; rootWidth: number; scrollTop: number; scrollLeft: number }> {
  return page.locator('[data-testid="browser-dom-input-overlay"]').first().evaluate((overlay, opts) => {
    const root = overlay.closest("[data-testid='browser-dom-cobrowse']") as HTMLElement;
    const box = root.getBoundingClientRect();
    const x = opts.point === "left" ? box.left + 10
      : opts.point === "right" ? box.right - 10
        : box.left + box.width / 2;
    const y = box.top + box.height / 2;
    const gestureY = opts.point === "center" ? y : opts.verticalFirst ? y - 15 : y - 5;
    const endX = x + (opts.direction === "right" ? 150 : -150);
    let currentY = y;
    const fire = (type: string, clientX: number, clientY = currentY) => {
      const current = new Touch({ identifier: 1, target: overlay, clientX, clientY });
      currentY = clientY;
      const active = type === "touchend" ? [] : [current];
      overlay.dispatchEvent(new TouchEvent(type, {
        bubbles: true,
        cancelable: true,
        touches: active,
        targetTouches: active,
        changedTouches: [current],
      }));
    };
    fire("touchstart", x);
    if (opts.point !== "center") {
      if (opts.verticalFirst) fire("touchmove", x, gestureY);
      else fire("touchmove", x + 5, y - 5);
    }
    for (let step = 1; step <= 6; step++) {
      fire("touchmove", x + (endX - x) * step / 6, gestureY);
    }
    const arrow = root.querySelector('[data-testid="browser-edge-swipe-arrow"]') as HTMLElement | null;
    const frame = root.querySelector("iframe") as HTMLIFrameElement;
    const state = {
      ready: arrow?.dataset.ready ?? null,
      arrowX: arrow ? Number.parseFloat(arrow.style.left) : null,
      rootWidth: box.width,
      scrollTop: frame.contentDocument?.scrollingElement?.scrollTop ?? 0,
      scrollLeft: frame.contentDocument?.scrollingElement?.scrollLeft ?? 0,
    };
    fire("touchend", endX);
    return state;
  }, { point, direction, verticalFirst });
}

test("edge swipes navigate the hosted page, while a center swipe still scrolls", async ({ page, context, request }) => {
  test.info().annotations.push({ type: "spec", description: "BROWSER-DOM-NAV-EDGE-01" });
  await pageLayout(page);
  const contextId = `e2e-edge-swipe-${Date.now()}`;
  const host = await hostNativePage(await context.newPage(), contextId, HOST_HTML, {
    size: HOST_SIZE,
    title: "Edge swipe host",
  });
  await resetPaneStore(request, [`browser:${contextId}`]);
  await goToApp(page);
  const mirror = page.locator('[data-testid="browser-dom-cobrowse"]').first();
  await expect(mirror.frameLocator("iframe").locator("#swipe-content")).toBeVisible({ timeout: 15_000 });

  const relayedBeforeBack = (await host.scrolls()).relayed;
  const backArrow = await swipe(page, "left", "right");
  expect(backArrow.ready).toBe("true");
  expect(backArrow.arrowX).toBeGreaterThan(100);
  expect(backArrow.scrollTop).toBe(0);
  expect(backArrow.scrollLeft).toBe(0);
  await expect.poll(() => host.scrolls().then(({ relayed }) => relayed)).toBe(relayedBeforeBack);
  await expect.poll(() => host.navigations()).toEqual({ back: 1, forward: 0 });

  const relayedBeforeForward = (await host.scrolls()).relayed;
  const forwardArrow = await swipe(page, "right", "left");
  expect(forwardArrow.ready).toBe("true");
  expect(forwardArrow.arrowX).toBeLessThan(forwardArrow.rootWidth - 100);
  expect(forwardArrow.scrollTop).toBe(0);
  expect(forwardArrow.scrollLeft).toBe(0);
  await expect.poll(() => host.scrolls().then(({ relayed }) => relayed)).toBe(relayedBeforeForward);
  await expect.poll(() => host.navigations()).toEqual({ back: 1, forward: 1 });

  const relayedBeforeVertical = (await host.scrolls()).relayed;
  await swipe(page, "left", "right", true);
  await expect.poll(() => host.navigations()).toEqual({ back: 1, forward: 1 });
  await expect.poll(() => host.scrolls().then(({ relayed }) => relayed)).toBeGreaterThan(relayedBeforeVertical);

  const centerSwipe = await swipe(page, "center", "left");
  expect(centerSwipe.ready).toBeNull();
  expect(centerSwipe.arrowX).toBeNull();
  expect(centerSwipe.scrollLeft).toBeGreaterThan(0);
  const frame = await mirror.locator("iframe").elementHandle().then((element) => element!.contentFrame());
  await expect.poll(() => frame!.evaluate(() => document.scrollingElement?.scrollLeft ?? 0)).toBeGreaterThan(0);
  await expect.poll(() => host.scrolls().then(({ relayed }) => relayed)).toBeGreaterThan(0);
  expect(host.navigations()).toEqual({ back: 1, forward: 1 });
  host.close();
});
