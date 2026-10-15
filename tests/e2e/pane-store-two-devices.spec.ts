import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore, seedPaneStore } from "./helpers/api-fixtures";
import { closeTabViaX, openTwoDevices, tabFor } from "./helpers/multi-client";
import { restartTestServer } from "./helpers/restart-test-server";
import { goToApp } from "./helpers";
import { hermetic } from "./fixtures/hermetic";
import { E2E_BASE } from "./helpers/test-server";

hermetic(test);

const BASE = E2E_BASE;
const PANE_STORE_KEY = "pane-store-v2";

// UI timeouts allow the 1,500 ms close countdown, 500 ms sync debounce, and WS delivery; 15 s covers app boot.

interface PaneStoreEnvelope {
  value?: {
    panes?: Record<string, unknown>;
    groups?: Record<string, { paneIds?: string[] }>;
    lastSeq?: number;
  };
  server_seq?: number;
}

async function serverSnapshot(request: APIRequestContext): Promise<PaneStoreEnvelope> {
  const response = await request.get(`${BASE}/api/ui-state/${PANE_STORE_KEY}`);
  expect(response.ok(), "l'API del pane-store deve rispondere").toBeTruthy();
  return response.json() as Promise<PaneStoreEnvelope>;
}

async function expectServerClosed(request: APIRequestContext, topicId: string): Promise<void> {
  await expect.poll(async () => {
    const snapshot = await serverSnapshot(request);
    return {
      pane: snapshot.value?.panes?.[topicId] !== undefined,
      grouped: Object.values(snapshot.value?.groups ?? {}).some((group) => group.paneIds?.includes(topicId)),
    };
  }, {
    timeout: 10_000,
    message: "dopo il debounce e il riarmo, il server deve registrare la chiusura",
  }).toEqual({ pane: false, grouped: false });
}

async function waitForApp(page: Page): Promise<void> {
  await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15_000 });
}

test.describe("@nightly D7f pane-store tra dispositivi", () => {
  let topic: { id: string; name: string; slug: string };
  let anchorTopic: { id: string; name: string; slug: string } | null = null;

  test.beforeEach(async ({ request }) => {
    anchorTopic = null;
    topic = await createTopic(request, `D7f-pane-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await resetPaneStore(request, [topic.id]);
  });

  test.afterEach(async ({ request }) => {
    if (anchorTopic?.id) await deleteTopic(request, anchorTopic.id).catch(() => {});
    if (topic?.id) await deleteTopic(request, topic.id).catch(() => {});
  });

  test("P.1 la chiusura si propaga, sopravvive al reload e non entra in un contesto nuovo @nightly", async ({ browser }) => {
    test.info().annotations.push({ type: "spec", description: "TAB-SYNC-01" }, { type: "spec", description: "TAB-SYNC-02" });
    const devices = await openTwoDevices(browser);
    let freshContext: Awaited<ReturnType<typeof browser.newContext>> | undefined;
    try {
      await expect(tabFor(devices.pageA, topic.id)).toHaveCount(1, { timeout: 10_000 });
      await expect(tabFor(devices.pageB, topic.id)).toHaveCount(1, { timeout: 10_000 });

      await closeTabViaX(devices.pageA, topic.id);
      await expect(tabFor(devices.pageA, topic.id)).toHaveCount(0, { timeout: 10_000 });
      // ui-state:updated hydrates connected clients, so the chat must disappear live.
      await expect(tabFor(devices.pageB, topic.id)).toHaveCount(0, { timeout: 10_000 });

      await devices.pageB.reload();
      await waitForApp(devices.pageB);
      await expect(tabFor(devices.pageB, topic.id)).toHaveCount(0, { timeout: 10_000 });

      freshContext = await browser.newContext({ baseURL: BASE });
      const freshPage = await freshContext.newPage();
      await goToApp(freshPage);
      await expect(tabFor(freshPage, topic.id)).toHaveCount(0, { timeout: 10_000 });
    } finally {
      await freshContext?.close().catch(() => {});
      await devices.dispose();
    }
  });

  test("P.2 uno snapshot addormentato non resuscita né rimanda la chat chiusa @nightly", async ({ browser, request }) => {
    test.info().annotations.push({ type: "spec", description: "TAB-SYNC-01" });
    // The Japan case is two devices whose clocks disagree: X was opened on one
    // whose clock reads 15 minutes ahead, so its openedAt is LATER than A's
    // close. With equal clocks the old rule (openedAt against the close's time)
    // drops X too, and this test could not tell it from the causal one.
    await seedPaneStore(request, async () => {
      const value: Record<string, unknown> = { ...(await serverSnapshot(request)).value };
      delete value.lastSeq;
      const panes = { ...(value.panes as Record<string, Record<string, unknown>>) };
      panes[topic.id] = { ...panes[topic.id], openedAt: Date.now() + 15 * 60_000 };
      return { ...value, panes };
    });
    const devices = await openTwoDevices(browser);
    try {
      await expect(tabFor(devices.pageB, topic.id)).toHaveCount(1, { timeout: 10_000 });
      await expect.poll(async () => devices.pageB.evaluate((key) => {
        const raw = localStorage.getItem(key);
        const value = raw ? JSON.parse(raw) as { panes?: Record<string, unknown> } : null;
        return value?.panes?.[topic.id] !== undefined;
      }, PANE_STORE_KEY), {
        timeout: 10_000,
        message: "il localStorage di B deve aver salvato X prima dello sleep",
      }).toBe(true);

      await devices.pageB.close();
      await closeTabViaX(devices.pageA, topic.id);
      await expect(tabFor(devices.pageA, topic.id)).toHaveCount(0, { timeout: 10_000 });
      await expectServerClosed(request, topic.id);

      const returningPage = await devices.ctxB.newPage();
      const resurrectingPuts: string[] = [];
      await returningPage.route(/\/api\/ui-state\/pane-store-v2(?:\?|$)/, async (route) => {
        const body = route.request().method() === "PUT" ? route.request().postData() ?? "" : "";
        if (body.includes(topic.id)) resurrectingPuts.push(body.slice(0, 200));
        await route.continue();
      });
      await goToApp(returningPage);
      await expect(tabFor(returningPage, topic.id)).toHaveCount(0, { timeout: 10_000 });

      // localStorage changes only after hydration applies the tombstone to the stale snapshot.
      await expect.poll(async () => returningPage.evaluate(({ key, id }) => {
        const raw = localStorage.getItem(key);
        if (!raw) return true;
        const value = JSON.parse(raw) as { panes?: Record<string, unknown> };
        return value.panes?.[id] === undefined;
      }, { key: PANE_STORE_KEY, id: topic.id }), {
        timeout: 10_000,
        message: "l'idratazione deve sostituire lo snapshot locale stantio",
      }).toBe(true);
      expect(resurrectingPuts, "B non deve rimandare al server la chat chiusa").toEqual([]);

      await devices.pageA.reload();
      await waitForApp(devices.pageA);
      await expect(tabFor(devices.pageA, topic.id)).toHaveCount(0, { timeout: 10_000 });
      await expectServerClosed(request, topic.id);
    } finally {
      await devices.dispose();
    }
  });

  test("P.3 una riapertura esplicita vince sulla chiusura precedente @nightly", async ({ browser }) => {
    test.info().annotations.push({ type: "spec", description: "CMD-03" }, { type: "spec", description: "TAB-SYNC-01" });
    const devices = await openTwoDevices(browser);
    try {
      await closeTabViaX(devices.pageA, topic.id);
      await expect(tabFor(devices.pageB, topic.id)).toHaveCount(0, { timeout: 10_000 });
      await expect(tabFor(devices.pageA, topic.id)).toHaveCount(0, { timeout: 10_000 });

      await devices.pageB.keyboard.press("Meta+Shift+T");
      await expect(tabFor(devices.pageB, topic.id)).toHaveCount(1, { timeout: 10_000 });

      // A reload checks the shared state even if the reopen does not reach A live.
      await devices.pageA.reload();
      await waitForApp(devices.pageA);
      await expect(tabFor(devices.pageA, topic.id)).toHaveCount(1, { timeout: 10_000 });
    } finally {
      await devices.dispose();
    }
  });

  test("P.4 la chiusura durante l'indisponibilità viene risincronizzata @nightly", async ({ browser, request }) => {
    test.info().annotations.push({ type: "spec", description: "TAB-SYNC-01" }, { type: "spec", description: "TAB-SYNC-02" });
    const anchor = await createTopic(request, `D7f-anchor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    anchorTopic = anchor;
    await resetPaneStore(request, [topic.id, anchor.id]);
    const devices = await openTwoDevices(browser);
    try {
      await expect(tabFor(devices.pageA, topic.id)).toHaveCount(1, { timeout: 10_000 });
      await expect(tabFor(devices.pageB, topic.id)).toHaveCount(1, { timeout: 10_000 });
      await expect(tabFor(devices.pageA, anchor.id)).toHaveCount(1, { timeout: 10_000 });

      // 4,500 ms cover the 1,500 ms close countdown, 500 ms debounce, three retries (200/400/800 ms with jitter), and margin.
      // Closing the anchor locally leaves a PUT in debounce when the socket drops.
      await closeTabViaX(devices.pageA, anchor.id);
      await expect(tabFor(devices.pageA, anchor.id)).toHaveCount(0, { timeout: 10_000 });
      const restarted = restartTestServer({ downtimeMs: 4500 });
      await expect(devices.pageA.locator('[data-testid="connection-status"]')).toHaveAttribute("data-alarm", "true", { timeout: 10_000 });

      await closeTabViaX(devices.pageA, topic.id);
      await expect(tabFor(devices.pageA, topic.id)).toHaveCount(0, { timeout: 10_000 });
      await restarted;

      await expect(devices.pageA.locator('[data-testid="connection-status"]')).not.toHaveAttribute("data-alarm", "true", { timeout: 15_000 });
      await expectServerClosed(request, topic.id);

      await devices.pageB.reload();
      await waitForApp(devices.pageB);
      await expect(tabFor(devices.pageB, topic.id)).toHaveCount(0, { timeout: 10_000 });
      await expectServerClosed(request, topic.id);
    } finally {
      await devices.dispose();
    }
  });
});
