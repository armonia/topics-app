import { test, expect } from "./fixtures/browser-v2.fixture";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, waitForTopicVisible, resetPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

/**
 * Engine switch (task 54601eeb) — the WEB pane's Native ↔ real-Chromium toggle.
 *
 * The toggle is a pure capability of GET /api/browsers/engines: hidden unless the
 * server reports it enabled (TOPICS_CHROMIUM_ENGINE + a Chromium installed). When
 * shown, clicking it sends set_engine over the WS; the mock mirrors the server by
 * echoing an `engine` broadcast, which flips the badge AND remounts the WS (so the
 * server can recreate the context on the new engine — observed here as a second
 * /ws/browser connection).
 *
 * Runs fully mocked (no real Chromium): the CDP screencast of a real browser is
 * the LIVE-only piece — this proves the client contract end-to-end.
 */
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
  await expect(page.locator('[data-browser-pane]').first()).toBeVisible({ timeout: 10000 });
}

test.describe("Engine switch (54601eeb) — web pane Native↔Chromium toggle", () => {
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, []);
  });

  test("toggle is HIDDEN when the server reports the capability disabled", async ({ page, browserProcessPageV2, request }) => {
    await browserProcessPageV2.mockBrowserWs({ framesPerSecond: 15 });
    await browserProcessPageV2.mockWebrtcPeer(); // streaming surface = WebRTC <video>
    await browserProcessPageV2.mockBrowserContexts([]);
    await browserProcessPageV2.mockRemoteBrowserPane({
      connected: true, url: "https://example.com", title: "Example", hasScreenshot: true,
    });
    // Stay in streaming mode (the toggle is streaming-only), then advertise disabled.
    await page.route(/\/api\/browsers\/framable/, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ framable: false }) }));
    await browserProcessPageV2.mockEngines({ enabled: false });

    const topic = await createTopic(request, `E2E-EngineOff-${Date.now()}`);
    try {
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      await mountBrowserPane(page, topic.id);
      // The streaming <video> proves the pane is up; the toggle must still be absent.
      await expect(page.locator('[data-testid="browser-webrtc-video"]')).toBeVisible({ timeout: 10000 });
      await expect(page.locator('[data-testid="browser-engine-toggle"]')).toHaveCount(0);
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });

  test("enabled → toggle shows Nativo, click switches to Chromium (badge + WS remount) and back", async ({ page, browserProcessPageV2, request }) => {
    await browserProcessPageV2.mockBrowserWs({ framesPerSecond: 15 });
    await browserProcessPageV2.mockBrowserContexts([]);
    await browserProcessPageV2.mockRemoteBrowserPane({
      connected: true, url: "https://example.com", title: "Example", hasScreenshot: true,
    });
    await page.route(/\/api\/browsers\/framable/, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ framable: false }) }));
    // Registered LAST so it wins the /api/browsers/engines match (last route wins).
    await browserProcessPageV2.mockEngines({ enabled: true, available: true, engine: "Google Chrome", extensions: 42 });

    const topic = await createTopic(request, `E2E-EngineOn-${Date.now()}`);
    try {
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      await mountBrowserPane(page, topic.id);

      const toggle = page.locator('[data-testid="browser-engine-toggle"]');
      await expect(toggle).toBeVisible({ timeout: 10000 });
      await expect(toggle).toContainText("Nativo");

      const connectsBefore = browserProcessPageV2.getWsConnectCount();

      // Switch to chromium: the mock WS echoes an `engine` broadcast → badge flips
      // to "Chromium · 42" and the client remounts the WS (recreate on new engine).
      await toggle.click();
      await expect(toggle).toContainText("Chromium · 42", { timeout: 5000 });
      await expect.poll(() => browserProcessPageV2.getWsConnectCount(), { timeout: 6000 }).toBeGreaterThan(connectsBefore);

      // Switch back to native.
      const connectsAfterChromium = browserProcessPageV2.getWsConnectCount();
      await toggle.click();
      await expect(toggle).toContainText("Nativo", { timeout: 5000 });
      await expect.poll(() => browserProcessPageV2.getWsConnectCount(), { timeout: 6000 }).toBeGreaterThan(connectsAfterChromium);
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });
});
