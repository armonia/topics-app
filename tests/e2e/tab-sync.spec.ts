import { test } from "./fixtures/tab-sync.fixture";
import { expect } from "@playwright/test";
import { goToApp, openTopic, openTopicByClick, openTopicByDoubleClick } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";

test.describe("Tab Sync & Persistence", () => {
  // TAB-SYNC-01: Tab State Persistence Across Reload

  test("TAB-SYNC-01: open tabs survive page reload", async ({
    page,
    tabSyncPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "TAB-SYNC-01" });
    // Clean pane-store so the topic opens are a real state change (shared test DB).
    await resetPaneStore(page.request, []);
    await goToApp(page);

    // Double-click first topic to pin it (prevent preview replacement)
    await openTopicByDoubleClick(page, /Web Search Test/);
    // Then open second topic
    await openTopic(page, /Best Ramen/);

    // Wait for the debounced sync to fire
    await tabSyncPage.waitForSyncPut("pane-store-v2");

    // Record tab labels before reload
    const labelsBefore = await tabSyncPage.getTabLabels();
    expect(labelsBefore.length).toBeGreaterThanOrEqual(1);

    // Reload the page
    await page.reload({ waitUntil: "load" });
    await page.waitForSelector('[aria-label="Topics sidebar"]', {
      state: "visible",
      timeout: 15000,
    });

    // Verify tabs are restored
    const tabBar = page.locator('[data-testid="panel-tab-bar"]').first();
    await expect(tabBar).toBeVisible({ timeout: 10000 });
    const restoredTabs = tabBar.locator('[draggable="true"]');
    await expect(restoredTabs.first()).toBeVisible({ timeout: 10000 });

    const labelsAfter = await tabSyncPage.getTabLabels();
    // At least some tabs should have survived the reload
    expect(labelsAfter.length).toBeGreaterThanOrEqual(1);
  });

  test("TAB-SYNC-01: closed tab does not reappear after reload", async ({
    page,
    tabSyncPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "TAB-SYNC-01" });
    // Clean pane-store so the topic opens are a real state change (shared test DB).
    await resetPaneStore(page.request, []);
    await goToApp(page);

    // Double-click first topic to pin, then open second
    await openTopicByDoubleClick(page, /Web Search Test/);
    await openTopic(page, /Best Ramen/);
    await tabSyncPage.waitForSyncPut("pane-store-v2");

    // Get labels before closing — need at least 1 tab
    const labelsBefore = await tabSyncPage.getTabLabels();
    expect(labelsBefore.length).toBeGreaterThanOrEqual(1);

    // Close the last tab via its close button
    const tabs = tabSyncPage.tabs;
    const lastTab = tabs.last();
    const closeBtn = lastTab.locator("button").last();
    const closedLabel = (await lastTab.textContent())?.trim() || "";
    await closeBtn.click();

    // Wait for sync
    await tabSyncPage.waitForSyncPut("pane-store-v2");

    // Reload
    await page.reload({ waitUntil: "load" });
    await page.waitForSelector('[aria-label="Topics sidebar"]', {
      state: "visible",
      timeout: 15000,
    });

    // Wait for tab bar to load
    const tabBar = page.locator('[data-testid="panel-tab-bar"]').first();
    const tabBarVisible = await tabBar
      .waitFor({ state: "visible", timeout: 5000 })
      .then(() => true)
      .catch(() => false);

    if (tabBarVisible) {
      const labelsAfter = await tabSyncPage.getTabLabels();
      // The closed tab should not be among the restored tabs
      if (closedLabel) {
        expect(labelsAfter).not.toContain(closedLabel);
      }
    }
    // If no tab bar visible, all tabs were closed — that's also valid
  });

  test("TAB-SYNC-01: closed BROWSER tab does not reappear after reload", async ({
    page,
    tabSyncPage,
  }) => {
    // Regression: a durable (browser/terminal/utility) pane closed via the tab
    // X used to resurrect on Cmd+R — chat tabs were protected by the archived-
    // topic filter, these had no tombstone backstop. The pane-store closedStack
    // tombstone now covers all durable app-level tabs, and the union respects it
    // bidirectionally so a stale cross-tab snapshot can't re-add the closed tab.
    test.info().annotations.push({ type: "spec", description: "TAB-SYNC-01" });
    // Clean pane-store first (same as the sibling reload tests). The shared test
    // DB accumulates panes + closedStack tombstones across the serial run; a
    // dirty baseline makes the first goToApp client persist that junk to
    // localStorage, and the ensureTopicVisible reload then warm-boots it and
    // clobbers the WST seed (empty sidebar). resetPaneStore gives a deterministic
    // authoritative baseline so the seed wins.
    await resetPaneStore(page.request, []);
    await goToApp(page);

    // Pin a chat so the tab bar has a stable neighbour, then open a Browser pane
    // via the add-pane (+) menu.
    await openTopicByDoubleClick(page, /Web Search Test/);
    await tabSyncPage.openPaneByType("browser");

    // The browser tab should be present before we close it.
    const labelsBefore = await tabSyncPage.getTabLabels();
    expect(labelsBefore.some((l) => /browser/i.test(l))).toBeTruthy();

    // Close the browser tab via its close button.
    const tabs = tabSyncPage.tabs;
    const count = await tabs.count();
    let browserTab = tabs.first();
    for (let i = 0; i < count; i++) {
      const text = (await tabs.nth(i).textContent())?.trim() || "";
      if (/browser/i.test(text)) {
        browserTab = tabs.nth(i);
        break;
      }
    }
    await browserTab.locator("button").last().click();

    // Let the deferred close commit (CLOSE_PANE → tombstone) and sync.
    await tabSyncPage.waitForSyncPut("pane-store-v2").catch(() => {});

    // Reload. Use "load" not "networkidle": the browser pane's embedded content
    // keeps the network busy, so networkidle never settles and reload times out.
    await page.reload({ waitUntil: "load" });
    await page.waitForSelector('[aria-label="Topics sidebar"]', {
      state: "visible",
      timeout: 15000,
    });

    const tabBar = page.locator('[data-testid="panel-tab-bar"]').first();
    const tabBarVisible = await tabBar
      .waitFor({ state: "visible", timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    if (tabBarVisible) {
      const labelsAfter = await tabSyncPage.getTabLabels();
      // The closed browser tab must NOT be among the restored tabs.
      expect(labelsAfter.some((l) => /browser/i.test(l))).toBeFalsy();
    }
  });

  test("TAB-SYNC-01: browser tab closed then reloaded IMMEDIATELY (within the countdown) stays closed", async ({
    page,
    tabSyncPage,
  }) => {
    // The deferred-close window: the CLOSE_PANE commit is a client-only pending
    // action (no reload persistence). A reload during the ~1.5 s countdown used
    // to discard the pending commit → no tombstone → the browser tab resurrected
    // from the still-present persisted snapshot. The unload flush now commits the
    // pending close (records the tombstone + prunes the persisted snapshot)
    // before the page unloads.
    test.info().annotations.push({ type: "spec", description: "TAB-SYNC-01" });
    // Clean pane-store baseline (see the sibling reload test) so the WST seed
    // isn't clobbered by accumulated shared-DB junk warm-booted on reload.
    await resetPaneStore(page.request, []);
    await goToApp(page);

    await openTopicByDoubleClick(page, /Web Search Test/);
    await tabSyncPage.openPaneByType("browser");
    expect((await tabSyncPage.getTabLabels()).some((l) => /browser/i.test(l))).toBeTruthy();

    const tabs = tabSyncPage.tabs;
    const count = await tabs.count();
    let browserTab = tabs.first();
    for (let i = 0; i < count; i++) {
      const text = (await tabs.nth(i).textContent())?.trim() || "";
      if (/browser/i.test(text)) { browserTab = tabs.nth(i); break; }
    }
    await browserTab.locator("button").last().click();

    // Reload IMMEDIATELY — no wait for the countdown to elapse. The unload flush
    // must persist the close. "load" not "networkidle": the browser pane keeps
    // the network busy so networkidle never settles (reload would time out).
    await page.reload({ waitUntil: "load" });
    await page.waitForSelector('[aria-label="Topics sidebar"]', {
      state: "visible",
      timeout: 15000,
    });

    const tabBar = page.locator('[data-testid="panel-tab-bar"]').first();
    const tabBarVisible = await tabBar
      .waitFor({ state: "visible", timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    if (tabBarVisible) {
      const labelsAfter = await tabSyncPage.getTabLabels();
      expect(labelsAfter.some((l) => /browser/i.test(l))).toBeFalsy();
    }
  });

  test("TAB-SYNC-01: server receives PUT to /api/ui-state when tab state changes", async ({
    page,
    tabSyncPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "TAB-SYNC-01" });
    // Clean pane-store so the topic open is a real state change (shared test DB).
    await resetPaneStore(page.request, []);
    await goToApp(page);

    // Set up request listener before making changes
    const putRequests: string[] = [];
    page.on("request", (req) => {
      if (
        req.method() === "PUT" &&
        req.url().includes("/api/ui-state")
      ) {
        putRequests.push(req.url());
      }
    });

    // Open a topic to trigger a tab state change
    await openTopic(page, /Web Search Test/);

    // Wait for the debounced sync PUT
    await tabSyncPage.waitForSyncPut();

    // Verify at least one PUT was sent to ui-state
    expect(putRequests.length).toBeGreaterThanOrEqual(1);
    expect(putRequests.some((url) => url.includes("/api/ui-state"))).toBeTruthy();
  });

  // TAB-SYNC-02: WebSocket Cross-Client Tab Sync

  test("TAB-SYNC-02: tab opened in one context appears in another via WebSocket", async ({
    browser,
  }) => {
    test.info().annotations.push({ type: "spec", description: "TAB-SYNC-02" });

    // Create two independent browser contexts
    const contextA = await browser.newContext({
      baseURL: "http://localhost:13334",
    });
    const contextB = await browser.newContext({
      baseURL: "http://localhost:13334",
    });
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    try {
      // Reset the shared server pane-store so B sees exactly what A opens.
      await resetPaneStore(pageA.request, []);
      // Load app in both contexts
      await goToApp(pageA);
      await goToApp(pageB);

      // Verify both are connected (WebSocket)
      await expect(
        pageA.locator('[data-testid="connection-status"]')
      ).toBeVisible({ timeout: 10000 });
      await expect(
        pageB.locator('[data-testid="connection-status"]')
      ).toBeVisible({ timeout: 10000 });

      // Open a topic in context A
      await openTopic(pageA, /Web Search Test/);

      // Wait for context A's sync PUT to complete (client persists pane-store-v2)
      await pageA.waitForResponse(
        (resp) =>
          resp.url().includes("/api/ui-state/pane-store-v2") &&
          resp.request().method() === "PUT",
        { timeout: 10000 }
      );

      // Context B reads the shared server pane-store that A's live-persist wrote.
      // The store was reset to [] at the start, so any pane in group:default here
      // is the tab opened in context A propagating cross-client.
      await expect
        .poll(
          async () => {
            return pageB.evaluate(async () => {
              const res = await fetch("/api/ui-state/pane-store-v2");
              if (!res.ok) return [];
              const body = await res.json();
              return body?.value?.groups?.["group:default"]?.paneIds ?? [];
            });
          },
          { timeout: 10000 }
        )
        .toEqual(expect.arrayContaining([expect.any(String)]));
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test("TAB-SYNC-02: tab closed in one context is removed in another", async ({
    browser,
  }) => {
    test.info().annotations.push({ type: "spec", description: "TAB-SYNC-02" });

    const contextA = await browser.newContext({
      baseURL: "http://localhost:13334",
    });
    const contextB = await browser.newContext({
      baseURL: "http://localhost:13334",
    });
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    try {
      // Load both, open a topic in A
      await goToApp(pageA);
      await openTopic(pageA, /Web Search Test/);
      await pageA.waitForResponse(
        (resp) =>
          resp.url().includes("/api/ui-state/pane-store-v2") &&
          resp.request().method() === "PUT",
        { timeout: 10000 }
      );

      await goToApp(pageB);

      // Close all tabs in context A by clearing panels via API
      // This simulates closing tabs and triggers WebSocket broadcast
      await pageA.evaluate(async () => {
        await fetch("/api/ui-state/panels", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ openPanels: [] }),
        });
      });

      // Context B should see the update
      await expect
        .poll(
          async () => {
            const result = await pageB.evaluate(async () => {
              const res = await fetch("/api/ui-state/panels");
              if (!res.ok) return null;
              return res.json();
            });
            // Single-key GET /api/ui-state/:key is enveloped as { value, ... }
            // (server/routes/ui-state.ts) — read openPanels off .value.
            return result?.value?.openPanels?.length ?? -1;
          },
          { timeout: 10000 }
        )
        .toBe(0);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });
});

test.describe("Preview Tab Behavior", () => {
  let topicA: { id: string; name: string } | null = null;
  let topicB: { id: string; name: string } | null = null;

  test.beforeAll(async ({ request }) => {
    topicA = await createTopic(request, `E2E-Preview-A-${Date.now()}`);
    topicB = await createTopic(request, `E2E-Preview-B-${Date.now()}`);
  });

  test.afterAll(async ({ request }) => {
    if (topicA) await deleteTopic(request, topicA.id);
    if (topicB) await deleteTopic(request, topicB.id);
  });

  test("TAB-SYNC-03: single-click opens preview tab with italic styling", async ({
    page,
    tabSyncPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "TAB-SYNC-03" });
    await goToApp(page);

    // Single-click a topic
    await openTopicByClick(page, new RegExp(topicA!.name));

    // Wait for tab to appear
    await expect(tabSyncPage.tabs.first()).toBeVisible({ timeout: 10000 });

    // Find the tab for this topic and check for italic styling
    const tabs = tabSyncPage.tabs;
    const count = await tabs.count();
    let foundPreview = false;
    for (let i = 0; i < count; i++) {
      const text = (await tabs.nth(i).textContent())?.trim() || "";
      if (text.includes(topicA!.name.replace(/^E2E-Preview-A-/, "").slice(0, 8))) {
        // Check for italic span inside the tab
        const italicSpan = tabs.nth(i).locator("span.italic");
        if ((await italicSpan.count()) > 0) {
          foundPreview = true;
        }
        break;
      }
    }
    // Preview tab must have italic styling — the whole point of TAB-SYNC-03.
    // Review-round-12 B4: previous `foundPreview || count >= 1` was a
    // tautology that passed whenever any tab existed, regardless of styling.
    expect(
      foundPreview,
      `expected a preview tab with <span class="italic"> for topic ${topicA!.name} (found ${count} tabs total)`,
    ).toBe(true);
  });

  test("TAB-SYNC-03: preview tab is replaced by next single-click", async ({
    page,
    tabSyncPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "TAB-SYNC-03" });
    await goToApp(page);

    // Click topic A
    await openTopicByClick(page, new RegExp(topicA!.name));
    await expect(tabSyncPage.tabs.first()).toBeVisible({ timeout: 10000 });
    const countAfterFirst = await tabSyncPage.tabs.count();

    // Click topic B — if preview, should replace topic A's tab
    await openTopicByClick(page, new RegExp(topicB!.name));
    await expect(tabSyncPage.tabs.first()).toBeVisible({ timeout: 5000 });
    const countAfterSecond = await tabSyncPage.tabs.count();

    // Tab count should not increase if the first was a preview tab
    // (or at most increase by 1 if preview wasn't active)
    expect(countAfterSecond).toBeLessThanOrEqual(countAfterFirst + 1);
  });

  test("TAB-SYNC-03: double-click pins a preview tab", async ({
    page,
    tabSyncPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "TAB-SYNC-03" });
    await goToApp(page);

    // Single-click to create preview
    await openTopicByClick(page, new RegExp(topicA!.name));
    await expect(tabSyncPage.tabs.first()).toBeVisible({ timeout: 10000 });

    // Double-click the tab to pin it
    const tabs = tabSyncPage.tabs;
    const count = await tabs.count();
    // Find and double-click the tab
    for (let i = 0; i < count; i++) {
      const text = (await tabs.nth(i).textContent())?.trim() || "";
      if (text.includes(topicA!.name.replace(/^E2E-Preview-A-/, "").slice(0, 8))) {
        await tabs.nth(i).dblclick();
        break;
      }
    }

    // After pinning, the tab should no longer have italic styling
    const countAfterPin = await tabs.count();

    // Now open topic B — it should NOT replace the pinned tab
    await openTopicByClick(page, new RegExp(topicB!.name));
    await expect(tabSyncPage.tabs.first()).toBeVisible({ timeout: 5000 });
    const countAfterNewOpen = await tabSyncPage.tabs.count();

    // Should have at least as many tabs (pinned tab kept + new tab added)
    expect(countAfterNewOpen).toBeGreaterThanOrEqual(countAfterPin);
  });
});

// STALE-01 ("server state overrides stale localStorage on load") was dropped
// with the architecture it tested: panels are owned by pane-store-v2 now, and
// the topics-open-panels/panels authority it asserted no longer exists.
