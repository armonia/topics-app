import { test, expect } from "@playwright/test";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, waitForTopicVisible } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";
import { hostNativePage } from "./helpers/native-host-page";
import { E2E_BASE } from "./helpers/test-server";
import { nextFrames } from "./helpers/frame-probe";

hermetic(test);
// An iPad held upright, with a finger.
test.use({ hasTouch: true, viewport: { width: 820, height: 1180 } });

/**
 * THE CHAT'S KEYBOARD TOOK THE BROWSER AWAY, on an iPad (reported 14/10).
 *
 * The chain: Safari zooms the page onto any field under 16px it focuses, and
 * above 768px the composer was 13px (the 16px rule only covered phones). On iOS
 * window.innerWidth follows the zoomed viewport: 820 / (16 / 13) = 666, under
 * the 768 the layout reads, so the topic's browser window was unmounted and the
 * shell folded into a phone's.
 *
 * What this engine can prove: the size of every field a finger can focus, which
 * is the threshold Safari zooms on. What it cannot: the zoom, which is Safari's
 * alone. The test applies it by hand, with the scale Safari aims for, so the
 * window it looks at is the one the person would see.
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
    await expect(browserWindow).toBeVisible();

    const composer = page.locator('[data-testid="chat-input-area"] textarea').first();
    await composer.tap();
    await expect(composer).toBeFocused();

    const underSixteen = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("input, textarea, select")]
      .filter((el) => el.getClientRects().length > 0)
      .filter((el) => !/^(checkbox|radio|range|color|file|hidden|button|submit|reset|image)$/.test(el.getAttribute("type") ?? ""))
      .map((el) => ({ field: el.dataset.testid ?? el.getAttribute("aria-label") ?? el.tagName, px: parseFloat(getComputedStyle(el).fontSize) }))
      .filter((f) => f.px < 16));
    expect(underSixteen).toEqual([]);

    // The keyboard as iOS reports it (the visual viewport shrinks, the layout
    // one does not) and the zoom Safari applies to the focused field: enough to
    // show its text at 16px, with window.innerWidth/innerHeight following it.
    await page.evaluate(() => {
      const field = document.activeElement as HTMLElement;
      const scale = Math.max(1, 16 / parseFloat(getComputedStyle(field).fontSize));
      const vv = window.visualViewport!;
      const width = window.innerWidth, height = window.innerHeight;
      Object.defineProperty(vv, "height", { get: () => (height - 320) / scale, configurable: true });
      Object.defineProperty(window, "innerWidth", { get: () => Math.round(width / scale), configurable: true });
      Object.defineProperty(window, "innerHeight", { get: () => Math.round(height / scale), configurable: true });
      vv.dispatchEvent(new Event("resize"));
      window.dispatchEvent(new Event("resize"));
    });

    // The resize listeners ran inside dispatchEvent; the render they asked for
    // lands within the next frames.
    await nextFrames(page, 5);
    await expect(browserWindow).toBeVisible();
    const [win, chat] = await Promise.all([browserWindow.boundingBox(), page.getByTestId("chat-panel").first().boundingBox()]);
    expect(win!.x + win!.width).toBeCloseTo(chat!.x + chat!.width, 0);
  } finally {
    await deleteTopic(request, topic.id).catch(() => {});
  }
});
