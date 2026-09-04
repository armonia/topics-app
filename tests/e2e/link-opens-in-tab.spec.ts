import { test, expect } from "./fixtures/browser-v2.fixture";
import { goToApp } from "./helpers";
import {
  createTopic,
  deleteTopic,
  waitForTopicVisible,
  resetPaneStore,
  closeAllBrowserContexts,
} from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/**
 * LINK-TAB-01: a link clicked in the chat opens a TAB of the Topics browser.
 *
 * The behaviour this replaces: every link went to `openExternalOnce`, i.e. the
 * system browser, i.e. a window outside an app that has a browser of its own.
 * Both tests below are RED before that change: the first saw no browser pane at
 * all, the second saw one (the link had gone out either way).
 *
 * The external channel is `window.open` on the web build (lib/shell/app.ts), so
 * stubbing it is the fake bridge: it records what would have left the app.
 */

/** Record every `window.open` and stop it from actually opening anything. */
async function stubExternalChannel(page: import("@playwright/test").Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __externalOpens: string[] }).__externalOpens = [];
    window.open = ((url?: string | URL) => {
      (window as unknown as { __externalOpens: string[] }).__externalOpens.push(String(url ?? ""));
      return null;
    }) as typeof window.open;
  });
}

async function externalOpens(page: import("@playwright/test").Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __externalOpens?: string[] }).__externalOpens ?? []);
}

test.afterAll(async ({ request }) => {
  await closeAllBrowserContexts(request);
});

test.describe("LINK-TAB-01 a chat link opens in a Topics tab", () => {
  test.beforeEach(async ({ request }, testInfo) => {
    testInfo.annotations.push({ type: "spec", description: "LINK-TAB-01" });
    await resetPaneStore(request, []);
  });

  test("a plain click mounts a browser pane instead of leaving the app", async ({
    page,
    browserProcessPageV2,
    request,
  }) => {
    await browserProcessPageV2.mockBrowserWs({ framesPerSecond: 15 });
    await browserProcessPageV2.mockBrowserContexts([]);
    await browserProcessPageV2.mockRemoteBrowserPane({
      connected: true,
      url: "about:blank",
      hasScreenshot: true,
    });
    await stubExternalChannel(page);

    const topic = await createTopic(request, `E2E-LinkTab-${Date.now()}`);
    try {
      await seedMessage(request, {
        sessionKey: topic.id,
        role: "assistant",
        content: "Look at [the docs](https://example.com/from-chat).",
      });
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      await page
        .locator(`[data-pane-id="${topic.id}"], [data-topic-id="${topic.id}"]`)
        .first()
        .click();

      const link = page.locator('a[href="https://example.com/from-chat"]').first();
      await expect(link).toBeVisible({ timeout: 15000 });
      await link.click();

      // The delivery: a browser pane in THIS window, and nothing handed to the
      // system browser.
      await expect(page.locator("[data-browser-pane]").first()).toBeVisible({ timeout: 15000 });
      expect(await externalOpens(page)).toEqual([]);
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });

  test("Cmd-click still goes out to the system browser", async ({
    page,
    browserProcessPageV2,
    request,
  }) => {
    await browserProcessPageV2.mockBrowserWs({ framesPerSecond: 15 });
    await browserProcessPageV2.mockBrowserContexts([]);
    await stubExternalChannel(page);

    const topic = await createTopic(request, `E2E-LinkExt-${Date.now()}`);
    try {
      await seedMessage(request, {
        sessionKey: topic.id,
        role: "assistant",
        content: "Look at [the docs](https://example.com/gesture).",
      });
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      await page
        .locator(`[data-pane-id="${topic.id}"], [data-topic-id="${topic.id}"]`)
        .first()
        .click();

      const link = page.locator('a[href="https://example.com/gesture"]').first();
      await expect(link).toBeVisible({ timeout: 15000 });
      await link.click({ modifiers: ["ControlOrMeta"] });

      await expect
        .poll(async () => await externalOpens(page), { timeout: 10000 })
        .toContain("https://example.com/gesture");
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });
});
