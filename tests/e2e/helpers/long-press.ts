import { expect, type Locator, type Page } from "@playwright/test";

/**
 * A touch that is really HELD DOWN: Playwright has no "touch and hold"
 * primitive, and `dispatchEvent` with object literals is not enough — React
 * reads `e.touches[0].clientX`, and the touch list wants real `Touch` objects
 * (identifier + target), or the handler gets `undefined` and the gesture never
 * starts. So the events are built inside the page.
 */
async function press(page: Page, selector: string): Promise<void> {
  await page.locator(selector).first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    const touch = new Touch({ identifier: 1, target: el, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 });
    (window as unknown as { __held?: { el: Element; touch: Touch } }).__held = { el, touch };
    el.dispatchEvent(new TouchEvent("touchstart", {
      bubbles: true, cancelable: true, touches: [touch], targetTouches: [touch], changedTouches: [touch],
    }));
  });
}

async function release(page: Page): Promise<void> {
  await page.evaluate(() => {
    const held = (window as unknown as { __held?: { el: Element; touch: Touch } }).__held;
    if (!held) return;
    held.el.dispatchEvent(new TouchEvent("touchend", {
      bubbles: true, cancelable: true, touches: [], targetTouches: [], changedTouches: [held.touch],
    }));
    delete (window as unknown as { __held?: unknown }).__held;
  });
}

/**
 * Hold, then let go — and WHEN to let go is the whole point.
 *
 * THE FLAKE THIS CLOSES, measured 2026-08-26 on shard 1 of a two-shard run:
 * `board-card-stop.spec.ts` went red on `getByRole("menuitem", {name:"Ferma"})`
 * after exhausting its retries, and passed on its own seconds later. The hold
 * was a flat 750 ms against the app's `LONG_PRESS_MS = 500`
 * (`client/src/hooks/useLongPress.ts:46`) — 250 ms of margin, and BOTH timers
 * live on the same main thread. Under a loaded shard the board's render blocks
 * that thread, the app's 500 ms timer fires LATE, and by then the finger has
 * already lifted: the gesture is cancelled and no menu ever opens. A bigger
 * number would only move the flake further out; the fix is to stop timing it.
 *
 * Pass `until` and the finger stays down until that thing is on screen, which
 * is the condition the gesture is FOR. No `waitForTimeout` — the repo forbids
 * fixed sleeps here (`tests/e2e/CONVENTIONS.md:16`) for exactly this reason.
 *
 * Without `until` the old behaviour is kept: a flat hold, fine where the caller
 * has nothing to wait for.
 */
export async function longPress(
  page: Page,
  selector: string,
  opts: { until?: Locator; ms?: number } = {},
): Promise<void> {
  const { until, ms = 750 } = opts;
  await press(page, selector);
  if (until) await expect(until).toBeVisible();
  else await page.locator(selector).first().evaluate((_el, hold) => new Promise<void>((r) => setTimeout(r, hold)), ms);
  await release(page);
}
