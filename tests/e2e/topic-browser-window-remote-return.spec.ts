import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { copyFileSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTwoDevices } from "./helpers/multi-client";
import {
  createTopic,
  deleteTopic,
  resetPaneStore,
  resetProjectPanes,
  seedProjectPane,
  closeAllBrowserContexts,
} from "./helpers/api-fixtures";
import { projectPanesKey } from "../../shared/project-keys";
import { goToApp } from "./helpers";
import { removeTmpDir } from "./helpers/file-project";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/**
 * A PAGE TAKEN BACK BY THE TOPIC WINDOW ON ANOTHER DEVICE LEAVES THIS PROJECT TOO.
 *
 * A page lent by a topic's browser window to a PROJECT layout lives in two
 * synced records: the topic window (`topic-browser:<topicId>`, where it sits in
 * `promoted`) and the project's tab identity (`topics-project-panes-<hash>`,
 * where it is a browser pane). Taking it back moves it from the second to the
 * first. The topic window record travels as a whole, so the other device sees
 * the sheet arrive at once; the project record is received ADDITIVELY (it can
 * only add tabs, never remove one, `useProjectChatSync.onServerHydrate`), and
 * the return writes no tombstone, because the page was not closed. So the other
 * device kept the pane AND drew the sheet: one contextId in two places, which
 * is the one thing the window exists to prevent.
 *
 * Two devices, as `openTwoDevices` builds them: nothing shared locally, the
 * server is the only road between them.
 */

const BASE = E2E_BASE;

async function seedWindow(
  request: APIRequestContext,
  topicId: string,
  value: Record<string, unknown>,
): Promise<void> {
  const res = await request.put(`${BASE}/api/ui-state/topic-browser:${topicId}`, {
    data: value,
    ignoreHTTPSErrors: true,
  });
  expect(res.ok()).toBeTruthy();
}

/** The project opens with its conversation and the lent page as a browser pane. */
async function seedProjectLayout(
  request: APIRequestContext,
  projectPath: string,
  topicId: string,
  contextId: string,
): Promise<void> {
  const res = await request.put(`${BASE}/api/ui-state/${projectPanesKey(realpathSync(projectPath))}`, {
    data: {
      nonChatPanes: [{
        id: `browser:${contextId}`,
        type: "browser",
        title: "Lent page",
        url: "https://example.com/lent",
        projectPath,
      }],
      openChatTopicIds: [topicId],
      activeChatTopicId: topicId,
    },
    ignoreHTTPSErrors: true,
  });
  expect(res.ok()).toBeTruthy();
}

/** The project's tab record as the SERVER holds it: the record a device's
 *  next merge reads, so the one a pane handed back would show up in. */
async function serverProjectHoldsPage(
  request: APIRequestContext,
  projectPath: string,
  contextId: string,
): Promise<boolean> {
  const res = await request.get(`${BASE}/api/ui-state/${projectPanesKey(realpathSync(projectPath))}`, {
    ignoreHTTPSErrors: true,
  });
  const body = (await res.json().catch(() => null)) as { value?: { nonChatPanes?: Array<{ id?: string }> } } | null;
  return (body?.value?.nonChatPanes ?? []).some((p) => p?.id === `browser:${contextId}`);
}

/** The topic window's record as the server holds it: is the page a sheet? */
async function serverWindowHoldsSheet(
  request: APIRequestContext,
  topicId: string,
  contextId: string,
): Promise<boolean> {
  const res = await request.get(`${BASE}/api/ui-state/topic-browser:${topicId}`, { ignoreHTTPSErrors: true });
  const body = (await res.json().catch(() => null)) as { value?: { tabs?: Array<{ contextId?: string }> } } | null;
  return (body?.value?.tabs ?? []).some((t) => t?.contextId === contextId);
}

/** Bring the conversation to the front of the project strip: the window is
 *  drawn over the chat, so it exists only while the chat is the visible tab. */
async function showChat(page: Page, topicId: string): Promise<void> {
  const chatTab = page.locator(`[data-pane-id="chat:${topicId}"]`).first();
  await expect(chatTab).toBeVisible({ timeout: 20000 });
  await chatTab.click();
  await expect(page.locator('[data-testid="topic-browser-window"]')).toBeVisible({ timeout: 15000 });
}

test.describe("TOPIC-BROWSER-01 ritorno nella finestra da un altro dispositivo", () => {
  test("TOPIC-BROWSER-01v: la pagina ripresa dalla finestra su un altro dispositivo esce anche dal progetto qui", async ({ browser, request }, testInfo) => {
    testInfo.annotations.push({ type: "spec", description: "TOPIC-BROWSER-01" });
    await resetPaneStore(request, []);
    const projectPath = mkdtempSync(join(tmpdir(), "e2e-tbw-remote-return-"));
    const topic = await createTopic(request, `E2E-TBW-RemoteReturn-${Date.now()}`, { projectPath });
    const ctx = `tbw-remote-return-${Date.now()}`;
    const dev = await openTwoDevices(browser, {
      contextOptions: { recordVideo: { dir: testInfo.outputPath("video"), size: { width: 1280, height: 800 } } },
      seed: async (req) => {
        await resetProjectPanes(req, projectPath);
        await seedProjectPane(req, projectPath);
        await seedProjectLayout(req, projectPath, topic.id, ctx);
        await seedWindow(req, topic.id, {
          mode: "min", minPos: { right: 24, bottom: 24 }, expandedWidth: null,
          tabs: [], activeContextId: null, promoted: [ctx],
        });
      },
    });
    const paneIn = (page: Page) => page.locator(`[data-testid="project-window"] [data-pane-id="browser:${ctx}"]`);
    const sheetIn = (page: Page) => page.locator(`[data-testid="topic-browser-sheet"][data-context-id="${ctx}"]`);
    try {
      // Both devices start from the same truth: the page is a pane of the
      // project, and the window only keeps its bar.
      for (const page of [dev.pageA, dev.pageB]) {
        await showChat(page, topic.id);
        await expect(paneIn(page)).toHaveCount(1, { timeout: 15000 });
        await expect(page.locator('[data-testid="topic-browser-window"]')).toHaveAttribute("data-mode", "loaned", { timeout: 15000 });
        await expect(sheetIn(page)).toHaveCount(0);
      }

      // Device B takes the page back through the window's «+».
      await dev.pageB.locator('[data-testid="topic-browser-add"]').click();
      const menu = dev.pageB.locator('[data-testid="topic-browser-add-menu"]');
      await expect(menu).toBeVisible();
      await menu.locator(`[data-testid="topic-browser-add-existing"][data-context-id="${ctx}"]`).click();
      await expect(paneIn(dev.pageB)).toHaveCount(0, { timeout: 15000 });
      await expect(sheetIn(dev.pageB)).toHaveCount(1, { timeout: 15000 });

      // Device A follows: the sheet arrives, and the pane goes. The second
      // assertion is the one the additive project channel used to fail.
      await expect(sheetIn(dev.pageA)).toHaveCount(1, { timeout: 15000 });
      await expect(paneIn(dev.pageA), "the page is drawn in ONE place on the other device").toHaveCount(0, { timeout: 15000 });

      // And it stays gone. A pane can only be handed back by a device that
      // still held it when it merged the project record and saved the merge;
      // both devices have let go above, so once the server's record is free of
      // the page as well, every such save has already landed and been heard.
      await expect.poll(() => serverProjectHoldsPage(request, projectPath, ctx), { timeout: 15000 }).toBe(false);
      await expect(paneIn(dev.pageA)).toHaveCount(0);
      await expect(paneIn(dev.pageB)).toHaveCount(0);
      await expect(sheetIn(dev.pageB)).toHaveCount(1);
    } finally {
      const videoA = dev.pageA.video();
      const videoB = dev.pageB.video();
      await dev.dispose();
      // The clips are final once the contexts are closed; named per device so
      // the evidence says which window is which.
      for (const [video, name] of [[videoA, "device-a-observer.webm"], [videoB, "device-b-returns.webm"]] as const) {
        const path = await video?.path().catch(() => null);
        if (path) copyFileSync(path, testInfo.outputPath(name));
      }
      await resetProjectPanes(request, projectPath).catch(() => {});
      await closeAllBrowserContexts(request).catch(() => {});
      await deleteTopic(request, topic.id).catch(() => {});
      removeTmpDir(projectPath);
    }
  });

  test("TOPIC-BROWSER-01w: ripresa dalla finestra sul desktop, la pagina esce dal progetto anche sul telefono", async ({ browser, request }, testInfo) => {
    // The phone is the device that cannot see the window (under 768 px it does
    // not exist, and its tab sheet offers no way home either), so it can only
    // be on the RECEIVING side of a return. That is where the hole hurts most:
    // a phone that keeps the pane keeps listing it in the project's tab record,
    // and every save it makes hands the page back to the desktop's layout,
    // drawn next to the very sheet it was taken back into.
    testInfo.annotations.push({ type: "spec", description: "TOPIC-BROWSER-01" });
    await resetPaneStore(request, []);
    const projectPath = mkdtempSync(join(tmpdir(), "e2e-tbw-phone-return-"));
    const topic = await createTopic(request, `E2E-TBW-PhoneReturn-${Date.now()}`, { projectPath });
    const ctx = `tbw-phone-return-${Date.now()}`;
    const dev = await openTwoDevices(browser, {
      contextOptions: { recordVideo: { dir: testInfo.outputPath("video"), size: { width: 1280, height: 800 } } },
      seed: async (req) => {
        await resetProjectPanes(req, projectPath);
        await seedProjectPane(req, projectPath);
        await seedProjectLayout(req, projectPath, topic.id, ctx);
        await seedWindow(req, topic.id, {
          mode: "min", minPos: { right: 24, bottom: 24 }, expandedWidth: null,
          tabs: [], activeContextId: null, promoted: [ctx],
        });
      },
    });
    const paneOnDesktop = dev.pageA.locator(`[data-testid="project-window"] [data-pane-id="browser:${ctx}"]`);
    const sheetOnDesktop = dev.pageA.locator(`[data-testid="topic-browser-sheet"][data-context-id="${ctx}"]`);
    const tabOnPhone = dev.pageB.locator(`[data-pane-id="browser:${ctx}"]`);
    try {
      // Device B is a phone, and it holds the lent page as a tab of the project.
      await dev.pageB.setViewportSize({ width: 390, height: 844 });
      await expect(tabOnPhone.first()).toBeVisible({ timeout: 20000 });

      // Device A, the desktop, takes the page back through the window's «+».
      await showChat(dev.pageA, topic.id);
      await expect(paneOnDesktop).toHaveCount(1, { timeout: 15000 });
      await dev.pageA.locator('[data-testid="topic-browser-add"]').click();
      const menu = dev.pageA.locator('[data-testid="topic-browser-add-menu"]');
      await expect(menu).toBeVisible();
      await menu.locator(`[data-testid="topic-browser-add-existing"][data-context-id="${ctx}"]`).click();
      await expect(paneOnDesktop).toHaveCount(0, { timeout: 15000 });
      await expect(sheetOnDesktop).toHaveCount(1, { timeout: 15000 });

      // The phone lets go of the tab: the page lives in the window now.
      await expect(tabOnPhone, "the phone no longer holds the page the desktop took back").toHaveCount(0, { timeout: 15000 });

      // And nothing hands it back to the desktop afterwards: same reasoning as
      // 01v, the phone has let go, so the server's record free of the page
      // means any save the phone merged before that has landed and been heard.
      await expect.poll(() => serverProjectHoldsPage(request, projectPath, ctx), { timeout: 15000 }).toBe(false);
      await expect(paneOnDesktop).toHaveCount(0);
      await expect(sheetOnDesktop).toHaveCount(1);
    } finally {
      const videoA = dev.pageA.video();
      const videoB = dev.pageB.video();
      await dev.dispose();
      for (const [video, name] of [[videoA, "device-a-desktop-returns.webm"], [videoB, "device-b-phone-observer.webm"]] as const) {
        const path = await video?.path().catch(() => null);
        if (path) copyFileSync(path, testInfo.outputPath(name));
      }
      await resetProjectPanes(request, projectPath).catch(() => {});
      await closeAllBrowserContexts(request).catch(() => {});
      await deleteTopic(request, topic.id).catch(() => {});
      removeTmpDir(projectPath);
    }
  });

  test("TOPIC-BROWSER-01x: un dispositivo assente durante il ritorno, al rientro, lascia la pane e non la riconsegna", async ({ browser, request }, testInfo) => {
    // The device that matters most is the one that was NOT listening: a phone
    // or a PWA asleep while the desktop took the page back. It comes back with
    // the lent page still in its own memory of the project's tabs (localStorage),
    // and nothing live tells it otherwise: the frame of the return was sent
    // while it was gone. What it reads on the way back in is the window record,
    // which names the page as a sheet, and the project layout it restores from
    // its own memory. Both arrive in whatever order the chunks and the network
    // decide, and the pane has to go in either order; if it stays, the next
    // save of this device's project tabs hands the page back to the other one
    // too (the project record is received additively).
    testInfo.annotations.push({ type: "spec", description: "TOPIC-BROWSER-01" });
    await resetPaneStore(request, []);
    const projectPath = mkdtempSync(join(tmpdir(), "e2e-tbw-cold-return-"));
    const topic = await createTopic(request, `E2E-TBW-ColdReturn-${Date.now()}`, { projectPath });
    const ctx = `tbw-cold-return-${Date.now()}`;
    const dev = await openTwoDevices(browser, {
      contextOptions: { recordVideo: { dir: testInfo.outputPath("video"), size: { width: 1280, height: 800 } } },
      seed: async (req) => {
        await resetProjectPanes(req, projectPath);
        await seedProjectPane(req, projectPath);
        await seedProjectLayout(req, projectPath, topic.id, ctx);
        await seedWindow(req, topic.id, {
          mode: "min", minPos: { right: 24, bottom: 24 }, expandedWidth: null,
          tabs: [], activeContextId: null, promoted: [ctx],
        });
      },
    });
    const paneIn = (page: Page) => page.locator(`[data-testid="project-window"] [data-pane-id="browser:${ctx}"]`);
    const sheetIn = (page: Page) => page.locator(`[data-testid="topic-browser-sheet"][data-context-id="${ctx}"]`);
    let pageA2: Page | null = null;
    try {
      for (const page of [dev.pageA, dev.pageB]) {
        await showChat(page, topic.id);
        await expect(paneIn(page)).toHaveCount(1, { timeout: 15000 });
        await expect(page.locator('[data-testid="topic-browser-window"]')).toHaveAttribute("data-mode", "loaned", { timeout: 15000 });
      }
      // Device A keeps the lent page in its own memory of the project, then
      // goes away. Its context (and so its localStorage) survives.
      await expect.poll(
        () => dev.pageA.evaluate((id) => Object.keys(localStorage)
          .filter((k) => k.startsWith("topics-project-panes-"))
          .some((k) => (localStorage.getItem(k) ?? "").includes(`browser:${id}`)), ctx),
        { timeout: 10000 },
      ).toBe(true);
      await dev.pageA.close();

      // Device B takes the page back while A is not listening.
      await dev.pageB.locator('[data-testid="topic-browser-add"]').click();
      const menu = dev.pageB.locator('[data-testid="topic-browser-add-menu"]');
      await expect(menu).toBeVisible();
      await menu.locator(`[data-testid="topic-browser-add-existing"][data-context-id="${ctx}"]`).click();
      await expect(paneIn(dev.pageB)).toHaveCount(0, { timeout: 15000 });
      await expect(sheetIn(dev.pageB)).toHaveCount(1, { timeout: 15000 });
      // B's saves of both records have reached the server: that is the state
      // A comes back to.
      await expect.poll(() => serverWindowHoldsSheet(request, topic.id, ctx), { timeout: 15000 }).toBe(true);
      await expect.poll(() => serverProjectHoldsPage(request, projectPath, ctx), { timeout: 15000 }).toBe(false);

      // Device A comes back, with the same memory it left with.
      pageA2 = await dev.ctxA.newPage();
      await pageA2.routeWebSocket(/\/ws\/browser\//, () => {});
      await goToApp(pageA2);
      await showChat(pageA2, topic.id);
      await expect(sheetIn(pageA2)).toHaveCount(1, { timeout: 15000 });
      await expect(paneIn(pageA2), "the device that was away draws the page in ONE place").toHaveCount(0, { timeout: 15000 });

      // And its saves do not hand the pane back to B. A has let go above, so
      // the server's record free of the page means anything A saved before
      // letting go has landed, and been heard by B.
      await expect.poll(() => serverProjectHoldsPage(request, projectPath, ctx), { timeout: 15000 }).toBe(false);
      await expect(paneIn(pageA2)).toHaveCount(0);
      await expect(paneIn(dev.pageB), "the device that took the page back is not handed the pane again").toHaveCount(0);
      await expect(sheetIn(dev.pageB)).toHaveCount(1);
    } finally {
      const videoA = pageA2?.video();
      const videoB = dev.pageB.video();
      await dev.dispose();
      for (const [video, name] of [[videoA, "device-a-comes-back.webm"], [videoB, "device-b-returns.webm"]] as const) {
        const path = await video?.path().catch(() => null);
        if (path) copyFileSync(path, testInfo.outputPath(name));
      }
      await resetProjectPanes(request, projectPath).catch(() => {});
      await closeAllBrowserContexts(request).catch(() => {});
      await deleteTopic(request, topic.id).catch(() => {});
      removeTmpDir(projectPath);
    }
  });
});
