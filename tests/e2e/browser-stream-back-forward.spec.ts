/**
 * @covers BROWSER-STREAM-HISTORY-01
 */
import { test, expect } from "./fixtures/browser-v2.fixture";
import type { Page } from "@playwright/test";
import { goToApp } from "./helpers";
import { closeAllBrowserContexts, createTopic, deleteTopic, resetPaneStore, waitForTopicVisible } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);
test.use({ video: "on" });

/**
 * The streaming pane's back and forward arrows (the tab sheet's row) follow
 * the server page's session history, which the server reads over CDP and puts
 * in the `nav` messages. The socket is the fixture's stub: the isolated test
 * server cannot launch Chromium on the Mac, and what this file proves is the
 * pane's half of the contract. The server's half (reading the history,
 * publishing it once per change) is in `server/browser-nav-history.test.ts`.
 */

const FIRST = "https://example.com/";
const SECOND = "https://example.com/#second";

async function openStreamingPane(page: Page, topicId: string, browser: import("./fixtures/browser-v2.fixture").BrowserProcessPageV2) {
  await goToApp(page);
  await waitForTopicVisible(page, topicId);
  await page.evaluate((tid) => {
    window.dispatchEvent(new CustomEvent("browser:open-and-navigate", { detail: { topicId: tid, url: "https://example.com" } }));
  }, topicId);
  await expect(page.locator('[role="tab"][data-pane-id^="browser:"]').first()).toBeVisible({ timeout: 15_000 });
  await browser.waitForWsConnected();
}

/** The sheet opens from the tab's dots, which come out on hover. */
async function openSheet(page: Page) {
  await page.locator('[data-pane-id^="browser:"]').first().hover();
  await page.getByTestId("browser-tab-menu").first().click();
  await expect(page.getByTestId("tab-sheet")).toBeVisible({ timeout: 10_000 });
}

test.describe("BROWSER-STREAM-HISTORY-01 - streaming back/forward follow the server history", () => {
  test.beforeEach(async ({ request, page, browserProcessPageV2 }) => {
    await resetPaneStore(request, []);
    // Stay on the server stream: a framable page would move to an iframe.
    await page.route(/\/api\/browsers\/framable/, (route) => route.fulfill({ json: { framable: false } }));
    await browserProcessPageV2.mockBrowserWs({ framesPerSecond: 15 });
    await browserProcessPageV2.mockBrowserContexts([]);
    await browserProcessPageV2.mockRemoteBrowserPane({ connected: true, url: FIRST, title: "Example", hasScreenshot: true });
  });

  test("the arrows light only where there is a page to go to", async ({ page, request, browserProcessPageV2 }) => {
    test.info().annotations.push({ type: "spec", description: "BROWSER-STREAM-HISTORY-01" });
    const topic = await createTopic(request, `E2E-StreamHistory-${Date.now()}`);
    try {
      await openStreamingPane(page, topic.id, browserProcessPageV2);
      const back = page.getByTestId("browser-tab-back");
      const forward = page.getByTestId("browser-tab-forward");

      // 1. A fresh page: nothing behind, nothing ahead.
      browserProcessPageV2.sendNavLoaded(FIRST, { canGoBack: false, canGoForward: false });
      await openSheet(page);
      await expect(back, "no page behind the first one").toBeDisabled({ timeout: 10_000 });
      await expect(forward, "no page ahead").toBeDisabled();

      // 2. A same-document navigation, sheet still open: back lights, live.
      browserProcessPageV2.sendNavWithinDocument(SECOND, { canGoBack: true, canGoForward: false });
      await expect(back, "a page behind now").toBeEnabled({ timeout: 10_000 });
      await expect(forward).toBeDisabled();

      // 3. Back is a real command: it reaches the server, and the server's
      //    next load says where the history stands.
      const sent = page.waitForRequest((r) => r.url().includes("/interact") && r.method() === "POST" && (r.postData() ?? "").includes('"back"'));
      await back.click();
      await sent;
      browserProcessPageV2.sendNavLoaded(FIRST, { canGoBack: false, canGoForward: true });
      await openSheet(page);
      await expect(back, "back at the first page").toBeDisabled({ timeout: 10_000 });
      await expect(forward, "the second page is ahead").toBeEnabled();

      // 4. A navigation that fails: the server sits on its error page, which
      //    it never shows the pane (url empty), but whose history it does:
      //    back is the way out, and the pruned page ahead is gone.
      browserProcessPageV2.sendNavWithinDocument("", { canGoBack: true, canGoForward: false });
      await expect(back, "back out of the error page").toBeEnabled({ timeout: 10_000 });
      await expect(forward, "the pruned page is not ahead any more").toBeDisabled();
      await page.keyboard.press("Escape");
      await openSheet(page);
      await expect(page.getByTestId("browser-tab-address-input"), "the pane keeps its own url").toHaveValue(/example\.com/);
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
      await closeAllBrowserContexts(request);
    }
  });

  test("an older server that sends no flags keeps both arrows enabled", async ({ page, request, browserProcessPageV2 }) => {
    test.info().annotations.push({ type: "spec", description: "BROWSER-STREAM-HISTORY-01" });
    const topic = await createTopic(request, `E2E-StreamHistoryOld-${Date.now()}`);
    try {
      await openStreamingPane(page, topic.id, browserProcessPageV2);
      browserProcessPageV2.sendNavLoaded(FIRST);
      await openSheet(page);
      await expect(page.getByTestId("browser-tab-back")).toBeEnabled({ timeout: 10_000 });
      await expect(page.getByTestId("browser-tab-forward")).toBeEnabled();
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
      await closeAllBrowserContexts(request);
    }
  });
});
