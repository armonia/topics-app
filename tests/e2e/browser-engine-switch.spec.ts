/**
 * @covers ENGSW-02
 */
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

/**
 * Open the TAB SHEET, where the engine switch lives since TOPIC-BROWSER-03.
 *
 * It used to be a pill floating over the page (top-left), i.e. a switch parked
 * on top of the thing it switches. Nothing permanent is allowed over a browser
 * pane's page any more, so the switch moved into the sheet's Session section and
 * the tab carries only the ANSWER, as one icon. The dots come out on hover, so
 * the pointer goes over the pane's tab first.
 */
async function openTabSheet(page: import("@playwright/test").Page): Promise<void> {
  await page.locator('[data-pane-id^="browser:"]').first().hover();
  await page.getByTestId("browser-tab-menu").first().click();
  await expect(page.getByTestId("browser-tab-sheet")).toBeVisible({ timeout: 10000 });
}

test.describe("Engine switch (54601eeb) — web pane Native↔Chromium toggle", () => {
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, []);
  });

  test("toggle is HIDDEN when the server reports the capability disabled", async ({ page, browserProcessPageV2, request }) => {
    test.info().annotations.push({ type: "spec", description: "ENGSW-02" });
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
      // The streaming <video> proves the pane is up; the switch must still be
      // absent — and absent WITH THE SHEET OPEN, otherwise the assertion only
      // proves the sheet is closed. A capability the server denies means the
      // command is never published, so the row is not drawn at all.
      await expect(page.locator('[data-testid="browser-webrtc-video"]')).toBeVisible({ timeout: 10000 });
      await openTabSheet(page);
      await expect(page.getByTestId("browser-tab-engine")).toHaveCount(0);
      // And nothing of it is left over the page either.
      await expect(page.locator('[data-testid="browser-engine-toggle"]')).toHaveCount(0);
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });

  test("enabled → the sheet shows Playwright, click switches to Chromium (label + tab icon + WS remount) and back", async ({ page, browserProcessPageV2, request }) => {
    test.info().annotations.push({ type: "spec", description: "ENGSW-02" });
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

      // The switch is a row of the sheet's Session section now, and the bundled
      // engine is NOT called "Nativo": that word names the device's own webview,
      // a different thing entirely. This one is the server's Playwright.
      await openTabSheet(page);
      const toggle = page.getByTestId("browser-tab-engine");
      await expect(toggle).toBeVisible({ timeout: 10000 });
      await expect(toggle).toContainText("Playwright");
      await expect(toggle).not.toContainText("Nativo");

      const connectsBefore = browserProcessPageV2.getWsConnectCount();

      // Switch to chromium: the mock WS echoes an `engine` broadcast → badge flips
      // to "Chromium · 42" and the client remounts the WS (recreate on new engine).
      await toggle.click();
      await expect(toggle).toContainText("Chromium · 42", { timeout: 5000 });
      // The tab grew the type icon: this pane is no longer the default kind.
      await expect(page.getByTestId("browser-tab-type-icon").first()).toHaveAttribute("data-kind", "chromium");
      await expect.poll(() => browserProcessPageV2.getWsConnectCount(), { timeout: 6000 }).toBeGreaterThan(connectsBefore);

      // Switch back to native.
      const connectsAfterChromium = browserProcessPageV2.getWsConnectCount();
      await toggle.click();
      await expect(toggle).toContainText("Playwright", { timeout: 5000 });
      await expect.poll(() => browserProcessPageV2.getWsConnectCount(), { timeout: 6000 }).toBeGreaterThan(connectsAfterChromium);
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });
});
