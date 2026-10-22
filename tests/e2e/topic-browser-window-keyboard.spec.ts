import { test, expect } from "@playwright/test";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, waitForTopicVisible } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";
import { hostNativePage } from "./helpers/native-host-page";
import { E2E_BASE } from "./helpers/test-server";
import { nextFrames } from "./helpers/frame-probe";

hermetic(test);
// An 11-inch iPad lying down, with a finger.
test.use({ hasTouch: true, viewport: { width: 1180, height: 734 } });

/** How far Safari scrolled the page to show the composer, lying down, measured in the iOS 26.5 simulator. */
const KEYBOARD_SCROLL = 422;

/**
 * THE CHAT'S KEYBOARD TOOK THE BROWSER AWAY, on an iPad (reported 14/10).
 *
 * With the keyboard up Safari shortens the viewport and scrolls the whole page
 * to show the composer. Client rects follow that scroll, the origin of
 * `position: fixed` does not: the window, fixed at the chat area's client rect,
 * sat 422 px above the chat, and its bottom edge above the screen.
 *
 * This engine has no on-screen keyboard. The same gap is made by hand: the body
 * is moved up with a transform, which moves the page's rects and, as the
 * containing block of the fixed boxes, their origin too. The scroll event Safari
 * fires with it is what makes the window measure again.
 *
 * @covers TOPIC-BROWSER-01
 */
test("on an iPad the chat's keyboard leaves the topic's browser window beside the chat", async ({ page, context, request }) => {
  test.setTimeout(120_000);
  const ctx = `e2e-kbd-window-${Date.now()}`;
  await hostNativePage(await context.newPage(), ctx, "<!doctype html><title>Kbd</title><p>Hosted page</p>", { size: { width: 1200, height: 800 }, title: "Kbd" });
  const topic = await createTopic(request, `E2E-KBD-WINDOW-${Date.now()}`);
  try {
    await goToApp(page);
    await waitForTopicVisible(page, topic.id);
    const res = await request.put(`${E2E_BASE}/api/ui-state/topic-browser:${topic.id}`, {
      data: { mode: "exp", minPos: null, expandedWidth: 480, tabs: [{ contextId: ctx, url: "https://example.com/hosted", title: "Kbd", openedBy: "user" }], activeContextId: ctx, promoted: [] },
      ignoreHTTPSErrors: true,
    });
    expect(res.ok()).toBeTruthy();
    await page.reload();
    await waitForTopicVisible(page, topic.id);
    await page.locator(`[data-pane-id="${topic.id}"], [data-topic-id="${topic.id}"]`).first().click();
    const browserWindow = page.getByTestId("topic-browser-window");
    const chat = page.getByTestId("chat-panel").first();
    await expect(browserWindow).toBeVisible();
    const before = await Promise.all([browserWindow.boundingBox(), chat.boundingBox()]);
    expect(Math.round(before[0]!.y)).toBe(Math.round(before[1]!.y));

    await page.evaluate((scroll) => {
      document.body.style.transform = `translateY(${-scroll}px)`;
      window.dispatchEvent(new Event("scroll"));
    }, KEYBOARD_SCROLL);
    await nextFrames(page, 5);

    // The window moves with the chat, edge for edge.
    const [win, area] = await Promise.all([browserWindow.boundingBox(), chat.boundingBox()]);
    expect(Math.round(area!.y)).toBe(Math.round(before[1]!.y) - KEYBOARD_SCROLL);
    expect(Math.round(win!.y)).toBe(Math.round(area!.y));
    expect(Math.round(win!.y + win!.height)).toBe(Math.round(area!.y + area!.height));
  } finally {
    await deleteTopic(request, topic.id).catch(() => {});
  }
});
