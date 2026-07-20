import { test, expect } from "./fixtures/browser-v2.fixture";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, waitForTopicVisible, resetPaneStore } from "./helpers/api-fixtures";
import { readFileSync } from "fs";
import { resolve as resolvePath } from "path";

/**
 * T1 DOM co-browse (client) — the native rrweb reconstruction path. The mock WS
 * answers the pane's set_render:'dom' with a real rrweb Meta+FullSnapshot(+incr)
 * burst (captured offline into fixtures/rrweb-sample.json); the pane's Replayer
 * must rebuild the page in its own engine (real browser, not a video). The
 * mirror ITSELF is the input surface: clicks and keystrokes captured inside the
 * iframe relay back as `input` messages, while text selection stays native and
 * local (the whole point of DOM mode over a pixel stream).
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

      // Input relay: a click lands INSIDE the interactive iframe (no capture
      // overlay anymore) and the in-iframe bridge relays it to the server as an
      // `input` click in source-page coords. Accumulate across polls (drain clears).
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

      // Keyboard relay: with focus inside the mirror, a printable key relays as
      // an `input` type action (the mirror itself never mutates locally).
      let typed = 0;
      await page.keyboard.press("a");
      await expect
        .poll(() => {
          typed += browserProcessPageV2
            .drainInputMessages()
            .filter((m) => {
              const t = m as { type?: string; action?: string; payload?: { text?: string } };
              return t?.type === "input" && t?.action === "type" && t?.payload?.text === "a";
            }).length;
          return typed;
        }, { timeout: 5000 })
        .toBeGreaterThan(0);

      // Native selection — the point of DOM mode: double-click selects the word
      // LOCALLY in this device's engine (the old capture overlay made this
      // impossible; a pixel stream cannot do it at all). frameLocator.dblclick()
      // can't be used here: Playwright doesn't map in-frame coords through the
      // wrapper's CSS transform (the fit scale), so the double-click would land
      // off-target — compute the visual point manually from the iframe's visual
      // box (post-transform) vs its recorded 900px layout width.
      const iframeBox = await dom.locator("iframe").boundingBox();
      // Aim at the START of the text (a <p> is block-wide; its center is empty
      // space past the last glyph, where a double-click only places a caret).
      const textPoint = await reconstructed.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x + 30, y: r.y + r.height / 2 };
      });
      if (!iframeBox) throw new Error("replayer iframe has no bounding box");
      const fitScale = iframeBox.width / 900; // recorded viewport width (rrweb Meta)
      await page.mouse.dblclick(
        iframeBox.x + textPoint.x * fitScale,
        iframeBox.y + textPoint.y * fitScale,
      );
      // Read the selection from the PARENT context (the sandboxed frame realm
      // under-reports); the double-click word-selects "DOM" natively.
      await expect
        .poll(() =>
          page.evaluate(() => {
            const iframe = document.querySelector('[data-testid="browser-dom-cobrowse"] iframe') as HTMLIFrameElement | null;
            return iframe?.contentDocument?.getSelection()?.toString() ?? "";
          }),
        )
        .toContain("DOM");
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });

  test("a non-framable localhost app renders via DOM co-browse, not a blank iframe [T1]", async ({ page, browserProcessPageV2, request }) => {
    // Regression: a local dev app that sends X-Frame-Options / frame-ancestors
    // (e.g. Quadra on :3100 → SAMEORIGIN) loaded BLANK in the iframe, because the
    // web pane used to force the iframe for ANY localhost URL ("il browser resta
    // bianco, non fa nulla"). localhost now goes through the framability probe;
    // non-framable → the DOM co-browse surface (the server mirrors the real DOM).
    await browserProcessPageV2.mockBrowserWs({ framesPerSecond: 10 });
    await browserProcessPageV2.mockBrowserContexts([]);
    await browserProcessPageV2.mockRemoteBrowserPane({
      connected: true,
      url: "http://localhost:5173/app",
      title: "Local Dev",
      hasScreenshot: true,
    });
    // The probe reports the local app as NON-framable (its framing headers block us).
    await page.route(/\/api\/browsers\/framable/, async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ framable: false }) });
    });
    browserProcessPageV2.mockDomCoBrowse(RRWEB_EVENTS);

    const topic = await createTopic(request, `E2E-LHFRAME-${Date.now()}`);
    try {
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      await mountBrowserPane(page, topic.id, "http://localhost:5173/app");

      // The DOM co-browse surface renders; the native iframe must NOT be used
      // (it would be a dead white pane behind the framing block).
      await expect(page.locator('[data-testid="browser-dom-cobrowse"]').first()).toBeVisible({ timeout: 8000 });
      await expect(page.locator('[data-testid="browser-iframe"]')).toHaveCount(0);
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
