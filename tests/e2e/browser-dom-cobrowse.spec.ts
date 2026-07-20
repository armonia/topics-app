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

  test("DOM is the default surface — reconstructs the page natively and relays input [T1]", async ({ page, browserProcessPageV2, request }) => {
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

      // Option A: DOM is the DEFAULT — NO toggle click. The pane requests 'dom' on
      // connect and the rrweb iframe reconstructs the page in this device's own
      // engine (real browser, not a video frame). The toolbar toggle merely reflects
      // the mode; it's the opt-out to video, not the way in.
      const dom = page.locator('[data-testid="browser-dom-cobrowse"]').first();
      await expect(dom).toBeVisible({ timeout: 8000 });
      const reconstructed = dom.frameLocator("iframe").locator("#hi");
      await expect(reconstructed).toHaveText("DOM COBROWSE OK", { timeout: 8000 });
      await expect(page.locator('[data-testid="browser-render-toggle"]').first()).toContainText("DOM");

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

  test("falls back to video when the server can't DOM-snapshot the page [T1]", async ({ page, browserProcessPageV2, request }) => {
    // Option A safety net. The pane defaults to DOM, but a page the server can't
    // snapshot (canvas/WebGL, blocked injection) forces render_mode:'video'. The pane
    // must then negotiate the pixel (WebRTC) surface — never strand on a blank DOM
    // overlay. mockDomUnsupported() makes the mock force video; mockWebrtcPeer() drives
    // the video to connected deterministically.
    await browserProcessPageV2.mockBrowserWs({ framesPerSecond: 10 });
    await browserProcessPageV2.mockWebrtcPeer();
    await browserProcessPageV2.mockBrowserContexts([]);
    await browserProcessPageV2.mockRemoteBrowserPane({
      connected: true,
      url: "https://example.com",
      title: "Example",
      hasScreenshot: true,
    });
    browserProcessPageV2.mockDomUnsupported();

    const topic = await createTopic(request, `E2E-DOMCB-VIDEO-${Date.now()}`);
    try {
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      await mountBrowserPane(page, topic.id);

      // The forced 'video' takes over: the WebRTC <video> is the visible surface and
      // the DOM overlay is NOT mounted. No manual interaction — the pane resolves it.
      await expect(page.locator('[data-testid="browser-webrtc-video"]').first()).toBeVisible({ timeout: 10000 });
      await expect(page.locator('[data-testid="browser-dom-cobrowse"]')).toHaveCount(0);
      await expect(page.locator('[data-testid="browser-render-toggle"]').first()).toContainText("Video");
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });
});
