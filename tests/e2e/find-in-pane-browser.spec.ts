import { test, expect } from "./fixtures/browser-v2.fixture";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, waitForTopicVisible } from "./helpers/api-fixtures";
import { readFileSync } from "fs";
import { resolve as resolvePath } from "path";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/**
 * ⌘F in the SHARED browser pane (BROWSER-FIND-04): the page there is an rrweb
 * copy rebuilt in this client's own iframe (`dom` mode), so the text is
 * already here and the pane's finder walks it; in `video` mode the page is
 * pixels and the bar says so, with the field disabled. In neither mode does
 * ⌘F fall back to the project search.
 *
 * Same mocks as browser-dom-cobrowse.spec.ts: the WS answers `set_render:'dom'`
 * with a captured rrweb burst whose page says «DOM COBROWSE OK».
 *
 * @covers BROWSER-FIND-04
 */
test.use({ video: "on" });

const RRWEB_EVENTS = JSON.parse(
  readFileSync(resolvePath(__dirname, "fixtures/rrweb-sample.json"), "utf-8"),
) as unknown[];

async function mountBrowserPane(page: import("@playwright/test").Page, topicId: string): Promise<void> {
  await page.evaluate((tid) => {
    window.dispatchEvent(new CustomEvent("browser:open-and-navigate", { detail: { topicId: tid, url: "https://example.com" } }));
  }, topicId);
  await expect(page.locator("[data-browser-pane]").first()).toBeVisible({ timeout: 10_000 });
}

test.describe("Cerca nel browser condiviso", () => {
  test("dom mode: the rebuilt page is searched in this client, the word highlighted", async ({ page, browserProcessPageV2, request }) => {
    await browserProcessPageV2.mockBrowserWs({ framesPerSecond: 10 });
    await browserProcessPageV2.mockBrowserContexts([]);
    await browserProcessPageV2.mockRemoteBrowserPane({ connected: true, url: "https://example.com", title: "Example", hasScreenshot: true });
    browserProcessPageV2.mockDomCoBrowse(RRWEB_EVENTS);
    const topic = await createTopic(request, `E2E-FIND-DOM-${Date.now()}`);
    try {
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      await mountBrowserPane(page, topic.id);
      const dom = page.locator('[data-testid="browser-dom-cobrowse"]').first();
      await expect(dom.frameLocator("iframe").locator("#hi")).toHaveText("DOM COBROWSE OK", { timeout: 8_000 });

      // The keyboard inside the pane (the capture field), then ⌘F.
      await page.locator('[data-testid="browser-dom-input-overlay"]').first().click({ position: { x: 40, y: 30 } });
      await page.keyboard.press("Meta+f");
      const pane = page.locator('[data-testid="browser-pane"]').first();
      const bar = pane.getByTestId("find-bar");
      await expect(bar).toBeVisible();
      await expect(bar.getByTestId("find-input")).toBeFocused();
      await expect(page.getByTestId("file-search")).toHaveCount(0);

      await page.keyboard.type("cobrowse ok");
      await expect(bar.getByTestId("find-count")).toHaveText("0 di 1", { timeout: 10_000 });
      await page.keyboard.press("Enter");
      await expect(bar.getByTestId("find-count")).toHaveText("1 di 1");
      // Highlighted in the IFRAME's own registry, where the page lives.
      await expect.poll(() => dom.locator("iframe").evaluate((el) => {
        const win = (el as HTMLIFrameElement).contentWindow as unknown as { CSS?: { highlights?: Map<string, { size: number }> } } | null;
        return win?.CSS?.highlights?.get("find-current")?.size ?? 0;
      }), { timeout: 10_000 }).toBe(1);
      await page.screenshot({ path: test.info().outputPath("browser-dom-find.png") });
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });

  test("video mode: the bar opens with the field disabled and says why", async ({ page, browserProcessPageV2, request }) => {
    await browserProcessPageV2.mockBrowserWs({ framesPerSecond: 10 });
    await browserProcessPageV2.mockWebrtcPeer();
    await browserProcessPageV2.mockBrowserContexts([]);
    await browserProcessPageV2.mockRemoteBrowserPane({ connected: true, url: "https://example.com", title: "Example", hasScreenshot: true });
    browserProcessPageV2.mockDomUnsupported();
    const topic = await createTopic(request, `E2E-FIND-VIDEO-${Date.now()}`);
    try {
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      await mountBrowserPane(page, topic.id);
      await expect(page.locator('[data-testid="browser-webrtc-video"]').first()).toBeVisible({ timeout: 10_000 });
      await page.locator('[data-testid="browser-webrtc-video"]').first().click({ position: { x: 40, y: 30 } });
      await page.keyboard.press("Meta+f");
      const bar = page.locator('[data-testid="browser-pane"]').first().getByTestId("find-bar");
      await expect(bar).toBeVisible();
      await expect(bar.getByTestId("find-input")).toBeDisabled();
      await expect(bar.getByTestId("find-unavailable")).toHaveText("Qui la pagina è un'immagine: la ricerca non c'è");
      await expect(page.getByTestId("file-search")).toHaveCount(0);
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });
});
