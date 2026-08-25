import { test, expect } from "./fixtures/browser-v2.fixture";
import { goToApp } from "./helpers";
import {
  createTopic,
  deleteTopic,
  waitForTopicVisible,
  resetPaneStore,
  closeAllBrowserContexts,
} from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

/**
 * T2 — native <iframe> render mode (CodePen-style) for the WEB pane.
 *
 * The web pane renders a real sandboxed <iframe> when the target is framable
 * AND no agent is driving it; otherwise it falls back to the server-side
 * screenshot stream. The framability decision comes from GET
 * /api/browsers/framable?url=… (mocked here).
 *
 * @covers BROWSER-01
 */
async function mountBrowserPane(
  page: import("@playwright/test").Page,
  topicId: string,
  url: string,
): Promise<void> {
  await page.evaluate(
    ({ tid, u }) => {
      window.dispatchEvent(
        new CustomEvent("browser:open-and-navigate", { detail: { topicId: tid, url: u } }),
      );
    },
    { tid: topicId, u: url },
  );
}

/**
 * Mock GET /api/browsers/framable. MUST be registered AFTER mockBrowserContexts
 * / mockRemoteBrowserPane — their broader "api/browsers" glob patterns also match
 * this path, and Playwright gives precedence to the LAST-registered route.
 */
async function mockFramable(page: import("@playwright/test").Page, framable: boolean): Promise<void> {
  await page.route(/\/api\/browsers\/framable/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ framable }),
    });
  });
}

// Chi sporca pulisce: vedi la docstring di `closeAllBrowserContexts`.
test.afterAll(async ({ request }) => {
  await closeAllBrowserContexts(request);
});

test.describe("T2 iframe render mode", () => {
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, []);
  });

  test("framable URL + no agent → native <iframe> (not the stream) [T2]", async ({ page, browserProcessPageV2, request }) => {
    await browserProcessPageV2.mockBrowserWs({ framesPerSecond: 15 });
    await browserProcessPageV2.mockBrowserContexts([]);
    await browserProcessPageV2.mockRemoteBrowserPane({
      connected: true, url: "https://example.com", title: "Example", hasScreenshot: true,
    });
    await mockFramable(page, true); // last → wins over the broader /api/browsers/* mocks

    const topic = await createTopic(request, `E2E-Iframe-${Date.now()}`);
    try {
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      await mountBrowserPane(page, topic.id, "https://example.com");

      const iframe = page.locator('[data-testid="browser-iframe"]');
      await expect(iframe).toBeVisible({ timeout: 10000 });
      await expect(iframe).toHaveAttribute("src", "https://example.com");
      // The screenshot-stream path must NOT be the active render (iframe early-returns).
      await expect(page.locator('[data-testid="browser-connection-indicator"]')).toHaveCount(0);
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });

  test("non-framable URL → screenshot stream (no iframe) [T2]", async ({ page, browserProcessPageV2, request }) => {
    await browserProcessPageV2.mockBrowserWs({ framesPerSecond: 15 });
    await browserProcessPageV2.mockWebrtcPeer(); // stream surface = WebRTC <video>
    await browserProcessPageV2.mockBrowserContexts([]);
    await browserProcessPageV2.mockRemoteBrowserPane({
      connected: true, url: "https://example.com", title: "Example", hasScreenshot: true,
    });
    await mockFramable(page, false);

    const topic = await createTopic(request, `E2E-Stream-${Date.now()}`);
    try {
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      await mountBrowserPane(page, topic.id, "https://example.com");

      // Streaming path renders the shared-session <video> (H.264 WebRTC), not a
      // JPEG <img> and not an iframe. The video becomes the visible surface once
      // the transport negotiates (mockWebrtcPeer drives it to connected).
      await expect(page.locator('[data-testid="browser-webrtc-video"]')).toBeVisible({ timeout: 10000 });
      await expect(page.locator('[data-testid="browser-iframe"]')).toHaveCount(0);
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });

  test("agent attaches → iframe flips to the stream so the agent can drive [T2]", async ({ page, browserProcessPageV2, request }) => {
    await browserProcessPageV2.mockBrowserWs({ framesPerSecond: 15 });
    await browserProcessPageV2.mockWebrtcPeer(); // stream surface = WebRTC <video>
    await browserProcessPageV2.mockBrowserContexts([]);
    await browserProcessPageV2.mockRemoteBrowserPane({
      connected: true, url: "https://example.com", title: "Example", hasScreenshot: true,
    });
    await mockFramable(page, true);

    const topic = await createTopic(request, `E2E-IframeAgent-${Date.now()}`);
    try {
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      await mountBrowserPane(page, topic.id, "https://example.com");

      const iframe = page.locator('[data-testid="browser-iframe"]');
      await expect(iframe).toBeVisible({ timeout: 10000 });

      // An agent takes over → the pane must switch to the streamed headless
      // (agents can't reach into a cross-origin iframe).
      await browserProcessPageV2.waitForWsConnected();
      browserProcessPageV2.broadcastAgentActive(true);
      await expect(iframe).toHaveCount(0, { timeout: 8000 });
      // Streamed headless is now the render — the shared-session <video> surface
      // mounts (the agent drives the same server-side page the viewers watch).
      await expect(page.locator('[data-testid="browser-webrtc-video"]')).toBeVisible({ timeout: 5000 });
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });

  test("iframe-mode pauses the server screencast (set_stream false), agent-attach resumes it [052f53ef]", async ({ page, browserProcessPageV2, request }) => {
    await browserProcessPageV2.mockBrowserWs({ framesPerSecond: 15 });
    await browserProcessPageV2.mockBrowserContexts([]);
    await browserProcessPageV2.mockRemoteBrowserPane({
      connected: true, url: "https://example.com", title: "Example", hasScreenshot: true,
    });
    await mockFramable(page, true);

    const topic = await createTopic(request, `E2E-IframePause-${Date.now()}`);
    try {
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      await mountBrowserPane(page, topic.id, "https://example.com");

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const seen: any[] = [];
      const pollStreams = () => {
        seen.push(...browserProcessPageV2.drainInputMessages());
        return seen.filter((m) => m?.type === "set_stream");
      };

      // Entering iframe-mode pauses the headless stream (no viewer for it).
      await expect(page.locator('[data-testid="browser-iframe"]')).toBeVisible({ timeout: 10000 });
      await expect.poll(() => pollStreams().some((m) => m.active === false), { timeout: 8000 }).toBe(true);

      // Agent attaches → back to the stream → resume the screencast.
      await browserProcessPageV2.waitForWsConnected();
      browserProcessPageV2.broadcastAgentActive(true);
      await expect.poll(() => pollStreams().some((m) => m.active === true), { timeout: 8000 }).toBe(true);
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });
});
