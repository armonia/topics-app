import { test, expect } from "./fixtures/browser-v2.fixture";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, waitForTopicVisible, resetPaneStore } from "./helpers/api-fixtures";
import { readFileSync } from "fs";
import { resolve as resolvePath } from "path";

/**
 * T1 DOM co-browse (client) — the native rrweb reconstruction path. The mock WS
 * answers the pane's set_render:'dom' with a real rrweb Meta+FullSnapshot(+incr)
 * burst (captured offline into fixtures/rrweb-sample.json); the pane's Replayer
 * must rebuild the page in its own engine (real browser, not a video), and the
 * overlay must relay a click back as an `input` message. The default video path
 * is untouched — this only exercises the opt-in toggle.
 */
const RRWEB_EVENTS = JSON.parse(
  readFileSync(resolvePath(__dirname, "fixtures/rrweb-sample.json"), "utf-8"),
) as unknown[];

async function mountBrowserPane(
  page: import("@playwright/test").Page,
  topicId: string,
  url = "https://example.com",
): Promise<void> {
  await page.evaluate(
    ({ tid, u }) => {
      window.dispatchEvent(
        new CustomEvent("browser:open-and-navigate", { detail: { topicId: tid, url: u } }),
      );
    },
    { tid: topicId, u: url },
  );
  await expect(page.locator('[data-testid="browser-url-input"]').first()).toBeVisible({ timeout: 10000 });
}

test.describe("T1 DOM co-browse", () => {
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, []);
  });

  test("toggle DOM reconstructs the page natively and relays input [T1]", async ({ page, browserProcessPageV2, request }) => {
    await browserProcessPageV2.mockBrowserWs({ framesPerSecond: 10 });
    await browserProcessPageV2.mockBrowserContexts([]);
    await browserProcessPageV2.mockRemoteBrowserPane({
      connected: true,
      url: "https://example.com",
      title: "Example",
      hasScreenshot: true,
    });
    browserProcessPageV2.mockDomCoBrowse(RRWEB_EVENTS);

    const topic = await createTopic(request, `E2E-DOMCB-${Date.now()}`);
    try {
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      await mountBrowserPane(page, topic.id);

      // Switch to DOM mode via the toolbar toggle (default is video).
      const toggle = page.locator('[data-testid="browser-render-toggle"]').first();
      await expect(toggle).toBeVisible({ timeout: 8000 });
      await toggle.click();

      // The DOM co-browse layer mounts and the rrweb iframe reconstructs the page:
      // real text, in this device's own engine (not a video frame).
      const dom = page.locator('[data-testid="browser-dom-cobrowse"]').first();
      await expect(dom).toBeVisible({ timeout: 8000 });
      const reconstructed = dom.frameLocator("iframe").locator("#hi");
      await expect(reconstructed).toHaveText("DOM COBROWSE OK", { timeout: 8000 });

      // Input relay: a click on the overlay reaches the server as an `input` click
      // (mapped to source-page coords). Accumulate across polls (drain clears).
      browserProcessPageV2.drainInputMessages();
      await dom.click({ position: { x: 40, y: 30 } });
      let clicks = 0;
      await expect
        .poll(() => {
          clicks += browserProcessPageV2
            .drainInputMessages()
            .filter((m) => {
              const t = m as { type?: string; action?: string };
              return t?.type === "input" && t?.action === "click";
            }).length;
          return clicks;
        }, { timeout: 5000 })
        .toBeGreaterThan(0);
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });
});
