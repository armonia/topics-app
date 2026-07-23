import { test } from "./fixtures/layout.fixture";
import { expect } from "@playwright/test";
import { goToApp, openTestChat } from "./helpers";
import { seedProjectPane, resetPaneStore } from "./helpers/api-fixtures";
import { mkdirSync, writeFileSync, rmSync } from "fs";

// A real on-disk project whose basename matches /topics-app/i, so the tests
// that call `layoutPage.openProject(/topics-app/i)` have a project to open in
// the isolated test env (which has no registered "topics-app"). The tab-driven
// sidebar only surfaces a project row while its `project:<path>` pane is open,
// so each such test seeds that pane BEFORE goToApp (see seedProjectPane).
const LAYOUT_PROJECT = `/tmp/e2e-layout-topics-app-${Date.now()}`;

test.describe("Layout & Navigation", () => {
  test.beforeAll(() => {
    mkdirSync(`${LAYOUT_PROJECT}/src`, { recursive: true });
    writeFileSync(
      `${LAYOUT_PROJECT}/package.json`,
      JSON.stringify(
        { name: "topics-app", scripts: { dev: "echo dev", build: "echo build" } },
        null,
        2
      )
    );
    writeFileSync(`${LAYOUT_PROJECT}/src/index.ts`, 'export const x = 1;\n');
  });

  test.afterAll(() => {
    rmSync(LAYOUT_PROJECT, { recursive: true, force: true });
  });
  test("LAYOUT-01: pane tab bar close and right-click context menu", async ({
    page,
    layoutPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
    await seedProjectPane(page.request, LAYOUT_PROJECT);
    await goToApp(page);
    await layoutPage.openProject(/topics-app/i);

    // Verify tab bar visible with at least one draggable tab
    const tabs = layoutPage.tabBar
      .first()
      .locator('[draggable="true"]');
    await expect(tabs.first()).toBeVisible({ timeout: 10000 });
    const initialTabCount = await tabs.count();
    expect(initialTabCount).toBeGreaterThanOrEqual(1);

    // Right-click first tab and verify context menu items
    await layoutPage.rightClickTab(0);
    const items = await layoutPage.getContextMenuItems();
    expect(items.some((t) => t.includes("Close"))).toBeTruthy();

    // Close via context menu "Close" button (first button in menu)
    const menu = page.locator('[role="menu"]').first();
    const closeBtn = menu.locator("button").filter({ hasText: /^Close/ }).first();
    await closeBtn.click();

    // Verify context menu dismissed
    await expect(menu).toBeHidden({ timeout: 5000 });

    // Test add pane (+) button: click it and verify dropdown menu appears
    const addPaneBtn = page.getByTitle("Add pane");
    if ((await addPaneBtn.count()) > 0) {
      await addPaneBtn.first().click();
      // Add pane dropdown is portaled — target its stable testid.
      const addMenu = page.locator('[data-testid="pane-add-menu"]').first();
      await expect(addMenu).toBeVisible({ timeout: 5000 });
      // Should have pane type options
      const menuButtons = addMenu.locator("button");
      expect(await menuButtons.count()).toBeGreaterThan(0);
      // Dismiss by pressing Escape
      await page.keyboard.press("Escape");
    }
  });

  test("LAYOUT-02: connection status indicator shows connected state", async ({
    page,
    layoutPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-02" });
    await goToApp(page);

    // Verify connection status badge is visible
    // NB: the aria-label / role="status" contract was dropped — the button is
    // now testid-only (data-testid="connection-status"), so we assert visibility.
    await expect(layoutPage.connectionStatus).toBeVisible({ timeout: 10000 });
  });

  test("LAYOUT-03: sidebar toggle via Cmd+B and toggle button", async ({
    page,
    layoutPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-02" });
    await goToApp(page);

    // Sidebar should be visible initially
    await expect(layoutPage.sidebar).toBeVisible({ timeout: 10000 });

    // Toggle sidebar hidden via Cmd+B. Collapse is a translateX(-100%) at
    // constant width (still "visible" to Playwright), so assert it slid
    // off-screen (right edge ≈ 0) instead of toBeHidden.
    await layoutPage.toggleSidebar();
    await expect.poll(async () => {
      const b = await page.locator('[aria-label="Topics sidebar"]').boundingBox();
      return b ? b.x + b.width : 0;
    }, { timeout: 4000 }).toBeLessThan(2);

    // Toggle sidebar visible again via Cmd+B
    await layoutPage.toggleSidebar();
    await expect(layoutPage.sidebar).toBeVisible({ timeout: 5000 });

    // Also test via the SidebarToggleButton click
    const toggleBtn = layoutPage.sidebarToggleButton;
    if ((await toggleBtn.count()) > 0) {
      await toggleBtn.first().click();
      await expect.poll(async () => {
        const b = await page.locator('[aria-label="Topics sidebar"]').boundingBox();
        return b ? b.x + b.width : 0;
      }, { timeout: 4000 }).toBeLessThan(2);
      await toggleBtn.first().click();
      await expect(layoutPage.sidebar).toBeVisible({ timeout: 5000 });
    }
  });

  test("LAYOUT-04: ProjectWindow opens with sub-panels and add-pane menu", async ({
    page,
    layoutPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-02" });
    await seedProjectPane(page.request, LAYOUT_PROJECT);
    await goToApp(page);
    await layoutPage.openProject(/topics-app/i);

    // Verify project window has tab bar with at least one pane tab
    const tabBar = layoutPage.tabBar.first();
    await expect(tabBar).toBeVisible({ timeout: 10000 });
    const tabs = tabBar.locator('[draggable="true"]');
    const initialCount = await tabs.count();
    expect(initialCount).toBeGreaterThanOrEqual(1);

    // Click the Add pane (+) button
    const addPaneBtn = page.getByTitle("Add pane");
    await expect(addPaneBtn.first()).toBeVisible({ timeout: 5000 });
    await addPaneBtn.first().click();

    // Verify dropdown menu appears with pane type options
    const addMenu = page.locator('[data-testid="pane-add-menu"]').first();
    await expect(addMenu).toBeVisible({ timeout: 5000 });
    const menuButtons = addMenu.locator("button");
    const menuCount = await menuButtons.count();
    expect(menuCount).toBeGreaterThan(0);

    // Collect menu item texts
    const menuTexts: string[] = [];
    for (let i = 0; i < menuCount; i++) {
      const text = await menuButtons.nth(i).textContent();
      if (text) menuTexts.push(text.trim());
    }

    // Should have recognizable pane types
    const knownTypes = ["Files", "Terminal", "Shell", "Git", "Browser", "Board", "Agents"];
    const hasKnown = menuTexts.some((t) =>
      knownTypes.some((k) => t.includes(k))
    );
    expect(hasKnown).toBeTruthy();

    // Select first pane type option to add a new tab
    await menuButtons.first().click();

    // Verify new tab appeared (or at least tab bar still has tabs)
    await expect(tabs.first()).toBeVisible({ timeout: 5000 });
  });

  test("LAYOUT-05: StandaloneChatGroup renders with tab bar and chat content", async ({
    page,
    layoutPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-02" });
    // Hermetic: a long serial run accumulates panes in the shared test DB, and a
    // prior test's teardown flush can leave the pane-store holding unrelated panes
    // that win the hydrate LWW and hide the baseline chat. Reset to empty first so
    // openTestChat's ensureTopicVisible seed is the authoritative last write.
    await resetPaneStore(page.request, []);
    await goToApp(page);
    // openAnyTopic() scans the sidebar for a clickable chat treeitem, but under
    // the tab-driven sidebar no ambient chat row exists until a tab is open — it
    // silently no-ops. Open the baseline topic deterministically instead.
    await openTestChat(page);

    // Verify message input textbox is visible (chat pane rendered)
    const textarea = page.getByRole("textbox", { name: /Message input/ }).first();
    await expect(textarea).toBeVisible({ timeout: 10000 });

    // Verify tab bar is visible for the standalone chat group
    await expect(layoutPage.tabBar.first()).toBeVisible({ timeout: 5000 });

    // Verify the main content area is present
    await expect(layoutPage.mainContent).toBeVisible({ timeout: 5000 });
  });

  test("LAYOUT-06: project window internal pane layout persists across reload", async ({
    page,
    layoutPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
    // Hermetic: reset the shared pane-store to EXACTLY our project pane so the
    // top level holds only `[project]`. Two "Add pane" (+) buttons then exist —
    // [0] on the top-level tab bar, [1] inside the ProjectWindowPane. Only the
    // project-internal one persists to `topics-project-panes-<hash>`, which is
    // what this test polls; the top-level one would add a standalone pane and
    // leave nonChatPanes at 0.
    await resetPaneStore(page.request, []);
    await seedProjectPane(page.request, LAYOUT_PROJECT);
    await goToApp(page);
    await layoutPage.openProject(/topics-app/i);

    // Wait for tab bar to be fully loaded
    const tabBar = layoutPage.tabBar.first();
    await expect(tabBar).toBeVisible({ timeout: 10000 });
    const tabs = tabBar.locator('[draggable="true"]');
    await expect(tabs.first()).toBeVisible({ timeout: 5000 });

    // Click the PROJECT-INTERNAL Add pane (+) button (the last one) to add a
    // non-chat pane INSIDE the project window.
    const addPaneBtn = page.getByTitle("Add pane");
    await expect(addPaneBtn.last()).toBeVisible({ timeout: 5000 });
    await addPaneBtn.last().click();

    // Wait for dropdown menu (G1: stable testid, not the stale z-[9999] class)
    const addMenu = page.locator('[data-testid="pane-add-menu"]').first();
    await expect(addMenu).toBeVisible({ timeout: 5000 });
    const menuButtons = addMenu.locator("button");
    const menuCount = await menuButtons.count();

    // Select a non-chat pane type to add to the project layout
    let clicked = false;
    for (let i = 0; i < menuCount; i++) {
      const text = ((await menuButtons.nth(i).textContent()) || "").trim();
      if (/Terminal|Shell|Files|Git|Browser|Board|Agents|Dashboard|Activity|Journal/i.test(text) &&
          !/Chat/i.test(text)) {
        await menuButtons.nth(i).click();
        clicked = true;
        break;
      }
    }
    if (!clicked) {
      await menuButtons.nth(menuCount - 1).click();
    }

    // Project layout persistence is DEVICE-LOCAL now: savePersistedTabState /
    // savePersistedLayoutState write `topics-project-panes-<hash>` +
    // `topics-project-layout-<hash>` to localStorage — the old
    // `PUT /api/ui-state/project-layout` never fires. Poll a project layout
    // localStorage key until it reflects the added non-chat pane (mirrors the
    // localStorage poll in split-screen-sync.spec.ts).
    const readNonChatPaneCount = async () =>
      page.evaluate(() => {
        let max = 0;
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i)!;
          if (!k.startsWith("topics-project-")) continue;
          try {
            const v = JSON.parse(localStorage.getItem(k) || "{}");
            const panes = Array.isArray(v?.nonChatPanes) ? v.nonChatPanes : [];
            if (panes.length > max) max = panes.length;
          } catch {
            /* not JSON */
          }
        }
        return max;
      });

    await expect
      .poll(readNonChatPaneCount, { timeout: 10000 })
      .toBeGreaterThanOrEqual(1);
    const paneCountBeforeReload = await readNonChatPaneCount();

    // Record tab count before reload to compare against restored state
    const tabCountBeforeReload = await tabs.count();
    expect(tabCountBeforeReload).toBeGreaterThanOrEqual(1);

    // Reload the page -- clears in-memory state, forces load from persistence
    await page.reload({ waitUntil: "load" });

    // Re-open the same project
    await layoutPage.openProject(/topics-app/i);

    // Verify project window loaded with tabs (proves layout was restored from persistence)
    const restoredTabBar = layoutPage.tabBar.first();
    await expect(restoredTabBar).toBeVisible({ timeout: 10000 });
    const restoredTabs = restoredTabBar.locator('[draggable="true"]');
    await expect(restoredTabs.first()).toBeVisible({ timeout: 5000 });

    // The device-local layout survived the reload: the added non-chat pane is
    // still recorded (localStorage persists across reload; the reopen re-reads it).
    const paneCountAfterReload = await readNonChatPaneCount();
    expect(paneCountAfterReload).toBeGreaterThanOrEqual(paneCountBeforeReload);
  });

  test("LAYOUT-07: cross-device panel sync updates UI without stale overwrites", async ({
    page,
    layoutPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
    await goToApp(page);

    // Ensure the app is loaded and WS is connected before testing sync.
    // NB: the aria-label / role="status" contract was dropped — the button is
    // testid-only now, so we assert visibility instead of the old attributes.
    await expect(layoutPage.connectionStatus).toBeVisible({ timeout: 10000 });

    // The AUTHORITATIVE open-panels channel is pane-store-v2 now — the client
    // no longer writes localStorage['topics-open-panels']. Read the current
    // server snapshot as the baseline a "second device" will extend.
    const PANE_KEY = "pane-store-v2";
    const snapshotBefore = await page.evaluate(async (key: string) => {
      const res = await fetch(`/api/ui-state/${key}`);
      if (!res.ok) return null;
      const body = await res.json();
      return body?.value ?? null;
    }, PANE_KEY);

    // Record the per-device focus key (must NOT change on a cross-device sync).
    const focusedBefore = await page.evaluate(() =>
      localStorage.getItem("pane-store-focused-id")
    );

    // Simulate a second device opening a new panel by writing pane-store-v2
    // directly (no X-Client-Id header → the server broadcasts it as a foreign
    // `ui-state:updated`, not a self-echo). The id is UUID-like so
    // usePanelLifecycle's openPanels validation KEEPS it (a non-UUID orphan
    // without a matching topic would be filtered out).
    const syncTestId = `00000000-0000-4000-8000-${Date.now()
      .toString(16)
      .padStart(12, "0")
      .slice(-12)}`;
    const base =
      snapshotBefore && typeof snapshotBefore === "object"
        ? (snapshotBefore as Record<string, any>)
        : {
            panes: {},
            groups: {},
            projects: {},
            groupOrder: ["group:default"],
            closedStack: [],
            lastSeq: 0,
          };
    const updated = JSON.parse(JSON.stringify(base));
    updated.panes = updated.panes ?? {};
    updated.groups = updated.groups ?? {};
    updated.groupOrder = Array.isArray(updated.groupOrder)
      ? updated.groupOrder
      : ["group:default"];
    if (!updated.groups["group:default"]) {
      updated.groups["group:default"] = {
        id: "group:default",
        paneIds: [],
        splitRatio: 1,
        splitAxis: "horizontal",
      };
      if (!updated.groupOrder.includes("group:default")) {
        updated.groupOrder.unshift("group:default");
      }
    }
    if (!Array.isArray(updated.groups["group:default"].paneIds)) {
      updated.groups["group:default"].paneIds = [];
    }
    updated.groups["group:default"].paneIds.push(syncTestId);
    updated.panes[syncTestId] = {
      id: syncTestId,
      type: "chat",
      title: "",
      topicId: syncTestId,
    };
    updated.lastSeq = (updated.lastSeq ?? 0) + 1;

    await page.evaluate(
      async ({ key, snap }: { key: string; snap: unknown }) => {
        await fetch(`/api/ui-state/${key}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(snap),
        });
      },
      { key: PANE_KEY, snap: updated }
    );

    // The WS `ui-state:updated` broadcast must reach this client and land in the
    // pane store without a stale overwrite — poll the persisted local snapshot
    // for the new pane id.
    await expect
      .poll(
        async () =>
          page.evaluate((id: string) => {
            const raw = localStorage.getItem("pane-store-v2");
            if (!raw) return false;
            try {
              const snap = JSON.parse(raw);
              const inPanes = !!snap?.panes?.[id];
              const inGroups = Object.values(snap?.groups ?? {}).some(
                (g: any) => Array.isArray(g?.paneIds) && g.paneIds.includes(id)
              );
              return inPanes || inGroups;
            } catch {
              return false;
            }
          }, syncTestId),
        { timeout: 10000 }
      )
      .toBe(true);

    // The per-device focus key was NOT overwritten by the incoming sync.
    const focusedAfter = await page.evaluate(() =>
      localStorage.getItem("pane-store-focused-id")
    );
    expect(focusedAfter).toBe(focusedBefore);

    // Clean up: restore the original snapshot (drop the synthetic pane) with a
    // higher seq so it supersedes the injected one for later tests.
    await page.evaluate(
      async ({ key, snap }: { key: string; snap: unknown }) => {
        await fetch(`/api/ui-state/${key}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(snap),
        });
      },
      { key: PANE_KEY, snap: { ...base, lastSeq: (updated.lastSeq ?? 0) + 1 } }
    );
  });
});
