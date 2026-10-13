import { test, expect } from "./fixtures/browser-v2.fixture";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, waitForTopicVisible, resetPaneStore } from "./helpers/api-fixtures";
import { readFileSync } from "fs";
import { resolve as resolvePath } from "path";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/**
 * One tap on the DOM mirror is ONE click on the remote page.
 *
 * Measured 13/10 from the iPad: actions on the shared browser "did not work".
 * The mirror relayed a click from `touchend`, and then the engine synthesized
 * mousedown + click for the same tap, which `onClick` relayed again: every tap
 * reached the page twice. A menu opened and closed at once, a "next" moved two
 * photos. The video path already knew (RemoteBrowserPanel, "dopo il touchend il
 * motore sintetizza mousedown+click") and relays from `onClick` alone.
 *
 * Counting without a sleep: a wheel after the tap relays a `scroll`, and the
 * socket is ordered, so once the scroll is in, every click of the tap is too.
 *
 * @covers BROWSER-DOM-TAP-01
 */
test.use({ video: "on" });

const RRWEB_EVENTS = JSON.parse(
  readFileSync(resolvePath(__dirname, "fixtures/rrweb-sample.json"), "utf-8"),
) as unknown[];

test.describe("DOM mirror on touch", () => {
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, []);
  });

  test("a tap relays exactly one click", async ({ page, browserProcessPageV2, request }) => {
    await browserProcessPageV2.mockBrowserWs({ framesPerSecond: 10 });
    await browserProcessPageV2.mockBrowserContexts([]);
    await browserProcessPageV2.mockRemoteBrowserPane({
      connected: true,
      url: "https://example.com",
      title: "Example",
      hasScreenshot: true,
    });
    browserProcessPageV2.mockDomCoBrowse(RRWEB_EVENTS);

    const topic = await createTopic(request, `E2E-DOMTAP-${Date.now()}`);
    try {
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      await page.evaluate((tid) => {
        window.dispatchEvent(new CustomEvent("browser:open-and-navigate", { detail: { topicId: tid, url: "https://example.com" } }));
      }, topic.id);

      const dom = page.locator('[data-testid="browser-dom-cobrowse"]').first();
      await expect(dom.frameLocator("iframe").locator("#hi")).toHaveText("DOM COBROWSE OK", { timeout: 8000 });

      const overlay = page.locator('[data-testid="browser-dom-input-overlay"]').first();
      const box = await overlay.boundingBox();
      expect(box).not.toBeNull();
      browserProcessPageV2.drainInputMessages();

      await page.touchscreen.tap(box!.x + 40, box!.y + 30);
      await page.mouse.move(box!.x + 60, box!.y + 60);
      await page.mouse.wheel(0, 40);

      const inputs: { action?: string }[] = [];
      await expect
        .poll(() => {
          for (const m of browserProcessPageV2.drainInputMessages()) {
            const t = m as { type?: string; action?: string };
            if (t?.type === "input") inputs.push(t);
          }
          return inputs.some((m) => m.action === "scroll");
        }, { timeout: 5000 })
        .toBe(true);

      expect(inputs.filter((m) => m.action === "click")).toHaveLength(1);
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });
});
