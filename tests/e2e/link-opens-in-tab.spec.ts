import { test, expect } from "./fixtures/browser-v2.fixture";
import { goToApp, openTopic } from "./helpers";
import {
  createTopic,
  deleteTopic,
  resetPaneStore,
  closeAllBrowserContexts,
} from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
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

/** The seed endpoint keys on the SESSION, which is not the topic id. */
async function sessionKeyOf(
  request: import("@playwright/test").APIRequestContext,
  topicId: string,
): Promise<string> {
  const res = await request.get(`${E2E_BASE}/api/topics`, { ignoreHTTPSErrors: true });
  const { topics } = (await res.json()) as {
    topics: Record<string, { id: string; sessionKey: string }>;
  };
  return Object.values(topics).find((t) => t.id === topicId)?.sessionKey ?? "";
}

test.afterAll(async ({ request }) => {
  await closeAllBrowserContexts(request);
});

test.describe("LINK-TAB-01 a chat link opens in a Topics tab", () => {
  test.beforeEach(async ({ request }, testInfo) => {
    testInfo.annotations.push({ type: "spec", description: "LINK-TAB-01" });
    await resetPaneStore(request, []);
  });

  /**
   * LINK-TAB-02 / TOPIC-BROWSER-04: a chat link on a desktop viewport no longer
   * tiles a cell. It lands in the topic's own browser window, which is the
   * whole point: an opening the user did not ask the LAYOUT for does not get to
   * rearrange it. What stays proven here is the original claim of this file -
   * the link does NOT leave the app.
   */
  test("LINK-TAB-02: a plain click lands in the topic window, not in a new pane", async ({
    page,
    browserProcessPageV2,
    request,
  }, testInfo) => {
    testInfo.annotations.push({ type: "spec", description: "LINK-TAB-02" });
    await browserProcessPageV2.mockBrowserWs({ framesPerSecond: 15 });
    await browserProcessPageV2.mockBrowserContexts([]);
    await browserProcessPageV2.mockRemoteBrowserPane({
      connected: true,
      url: "about:blank",
      hasScreenshot: true,
    });
    await stubExternalChannel(page);

    const name = `E2E-LinkTab-${Date.now()}`;
    const topic = await createTopic(request, name);
    try {
      await seedMessage(request, {
        sessionKey: await sessionKeyOf(request, topic.id),
        role: "assistant",
        content: "Look at [the docs](https://example.com/from-chat).",
      });
      await goToApp(page);
      await openTopic(page, new RegExp(name));

      const link = page.locator('a[href="https://example.com/from-chat"]').first();
      await expect(link).toBeVisible({ timeout: 15000 });
      await link.click();

      // The delivery: the topic's window, minimised, with the page as its
      // active sheet - and NOT a pane tiled into the layout.
      const windowEl = page.locator('[data-testid="topic-browser-window"]');
      await expect(windowEl).toBeVisible({ timeout: 15000 });
      await expect(windowEl).toHaveAttribute("data-mode", "min");
      await expect(page.locator('[data-testid="topic-browser-sheet"]')).toHaveCount(1, { timeout: 15000 });
      await expect(page.locator('[data-pane-id^="browser:"]')).toHaveCount(0);
      // And nothing was handed to the system browser.
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

    const name = `E2E-LinkExt-${Date.now()}`;
    const topic = await createTopic(request, name);
    try {
      await seedMessage(request, {
        sessionKey: await sessionKeyOf(request, topic.id),
        role: "assistant",
        content: "Look at [the docs](https://example.com/gesture).",
      });
      await goToApp(page);
      await openTopic(page, new RegExp(name));

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
