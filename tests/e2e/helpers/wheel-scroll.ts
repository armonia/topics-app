import { expect, type Locator, type Page } from "@playwright/test";

/** The chat scroller ON SCREEN: a tab behind another keeps its own mounted. */
export const VISIBLE_CHAT_SCROLLER = '[data-testid="chat-message-list"]:visible';

/**
 * Scrolls the list UP with the wheel - a gesture, not a `scrollTop` write -
 * until `target` is visible. A programmatic scroll inside the opening window
 * is undone by the opening pins (a re-measure brings the list back to the
 * bottom); the wheel is what a reader does, and the first wheel closes that
 * window (`markGesture` in MessageList).
 *
 * Shared by the specs that read a tail-first chat upwards (CHAT-HIST-01):
 * `chat-tail-first.spec.ts`, `chat-history-window.spec.ts`.
 */
export async function wheelUpUntilVisible(
  page: Page,
  target: Locator,
  steps = 60,
  scrollerSelector = VISIBLE_CHAT_SCROLLER,
): Promise<void> {
  const scroller = page.locator(scrollerSelector);
  const box = await scroller.boundingBox();
  if (!box) throw new Error("the visible scroller has no box to wheel over");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < steps; i++) {
    if (await target.isVisible()) return;
    await page.mouse.wheel(0, -4000);
    // Virtuoso mounts the rows it reaches on the next frame: give it one.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  }
  await expect(target).toBeVisible({ timeout: 5000 });
}
