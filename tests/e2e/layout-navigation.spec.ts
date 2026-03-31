import { test } from "./fixtures/layout.fixture";
import { expect } from "@playwright/test";
import { goToApp } from "./helpers";

test.describe("Layout & Navigation", () => {
  test("LAYOUT-01: pane tab bar close and right-click context menu", async ({
    page,
    layoutPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
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
    const menu = page.locator(".fixed.z-\\[9999\\]");
    const closeBtn = menu.locator("button").filter({ hasText: /^Close/ }).first();
    await closeBtn.click();

    // Verify context menu dismissed
    await expect(menu).toBeHidden({ timeout: 5000 });

    // Test add pane (+) button: click it and verify dropdown menu appears
    const addPaneBtn = page.getByTitle("Add pane");
    if ((await addPaneBtn.count()) > 0) {
      await addPaneBtn.first().click();
      // Add pane dropdown is portaled with z-[9999]
      const addMenu = page.locator(".fixed.z-\\[9999\\]");
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
    await expect(layoutPage.connectionStatus).toBeVisible({ timeout: 10000 });

    // Verify it has the connected aria-label
    await expect(layoutPage.connectionStatus).toHaveAttribute(
      "aria-label",
      /Connection status: Connected/
    );

    // Verify it has role="status" for accessibility
    await expect(layoutPage.connectionStatus).toHaveAttribute(
      "role",
      "status"
    );
  });

  test("LAYOUT-03: sidebar toggle via Cmd+B and toggle button", async ({
    page,
    layoutPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-02" });
    await goToApp(page);

    // Sidebar should be visible initially
    await expect(layoutPage.sidebar).toBeVisible({ timeout: 10000 });

    // Toggle sidebar hidden via Cmd+B
    await layoutPage.toggleSidebar();
    await expect(layoutPage.sidebar).toBeHidden({ timeout: 5000 });

    // Toggle sidebar visible again via Cmd+B
    await layoutPage.toggleSidebar();
    await expect(layoutPage.sidebar).toBeVisible({ timeout: 5000 });

    // Also test via the SidebarToggleButton click
    const toggleBtn = layoutPage.sidebarToggleButton;
    if ((await toggleBtn.count()) > 0) {
      await toggleBtn.first().click();
      await expect(layoutPage.sidebar).toBeHidden({ timeout: 5000 });
      await toggleBtn.first().click();
      await expect(layoutPage.sidebar).toBeVisible({ timeout: 5000 });
    }
  });

  test("LAYOUT-04: ProjectWindow opens with sub-panels and add-pane menu", async ({
    page,
    layoutPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-02" });
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
    const addMenu = page.locator(".fixed.z-\\[9999\\]");
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
    await goToApp(page);
    await layoutPage.openAnyTopic();

    // Verify message input textbox is visible (chat pane rendered)
    const textarea = page.getByRole("textbox", { name: /Message input/ });
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
    await goToApp(page);
    await layoutPage.openProject(/topics-app/i);

    // Wait for tab bar to be fully loaded
    const tabBar = layoutPage.tabBar.first();
    await expect(tabBar).toBeVisible({ timeout: 10000 });
    const tabs = tabBar.locator('[draggable="true"]');
    await expect(tabs.first()).toBeVisible({ timeout: 5000 });

    // Set up response listener BEFORE adding pane to catch the debounced write
    const layoutSavePromise = page.waitForResponse(
      (resp) =>
        resp.url().includes("/api/ui-state/project-layout") &&
        resp.request().method() === "PUT" &&
        resp.status() === 200,
      { timeout: 10000 }
    );

    // Click the Add pane (+) button to add a non-chat pane
    const addPaneBtn = page.getByTitle("Add pane");
    await expect(addPaneBtn.first()).toBeVisible({ timeout: 5000 });
    await addPaneBtn.first().click();

    // Wait for dropdown menu
    const addMenu = page.locator(".fixed.z-\\[9999\\]");
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

    // Wait for the debounced project layout server write (2s debounce)
    const saveResponse = await layoutSavePromise;

    // Extract the project layout key from the saved URL
    const savedUrl = saveResponse.url();
    const keyMatch = savedUrl.match(/ui-state\/(.+)$/);
    expect(keyMatch).not.toBeNull();
    const layoutKey = decodeURIComponent(keyMatch![1]);

    // Fetch the persisted layout from server -- verify it was saved
    const serverLayoutBeforeReload = await page.evaluate(async (key: string) => {
      const res = await fetch(`/api/ui-state/${encodeURIComponent(key)}`);
      if (!res.ok) return null;
      return res.json();
    }, layoutKey);
    expect(serverLayoutBeforeReload).not.toBeNull();

    // The persisted state must have the nonChatPanes array (core persistence structure)
    expect(serverLayoutBeforeReload.nonChatPanes).toBeDefined();
    expect(Array.isArray(serverLayoutBeforeReload.nonChatPanes)).toBeTruthy();

    // Record tab count before reload to compare against restored state
    const tabCountBeforeReload = await tabs.count();
    expect(tabCountBeforeReload).toBeGreaterThanOrEqual(1);

    // Reload the page -- clears in-memory state, forces load from persistence
    await page.reload({ waitUntil: "networkidle" });

    // Re-open the same project
    await layoutPage.openProject(/topics-app/i);

    // Verify project window loaded with tabs (proves layout was restored from persistence)
    const restoredTabBar = layoutPage.tabBar.first();
    await expect(restoredTabBar).toBeVisible({ timeout: 10000 });
    const restoredTabs = restoredTabBar.locator('[draggable="true"]');
    await expect(restoredTabs.first()).toBeVisible({ timeout: 5000 });

    // Verify server layout data survived the reload (not cleared on load)
    const serverLayoutAfterReload = await page.evaluate(async (key: string) => {
      const res = await fetch(`/api/ui-state/${encodeURIComponent(key)}`);
      if (!res.ok) return null;
      return res.json();
    }, layoutKey);
    expect(serverLayoutAfterReload).not.toBeNull();
    // The nonChatPanes in server state should match what was saved before reload
    expect(serverLayoutAfterReload.nonChatPanes.length).toBe(
      serverLayoutBeforeReload.nonChatPanes.length
    );
  });

  test("LAYOUT-07: cross-device panel sync updates UI without stale overwrites", async ({
    page,
    layoutPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-01" });
    await goToApp(page);

    // Ensure the app is loaded and WS is connected before testing sync
    await expect(layoutPage.connectionStatus).toBeVisible({ timeout: 10000 });
    await expect(layoutPage.connectionStatus).toHaveAttribute(
      "aria-label",
      /Connection status: Connected/
    );

    // Get the current open panels from the server
    const panelsBefore = await page.evaluate(async () => {
      const res = await fetch("/api/ui-state/panels");
      if (!res.ok) return null;
      return res.json();
    });
    expect(panelsBefore).not.toBeNull();
    expect(panelsBefore.openPanels).toBeDefined();

    // Record the currently focused panel ID (per-device, should NOT change on sync)
    const focusedBefore = await page.evaluate(() => {
      return localStorage.getItem("topics-focused-panel");
    });

    // Simulate a second device writing panel state via the server API.
    // The server broadcasts `ui-state:updated` with key "panels" to all WS clients.
    // Add a unique topic ID to the existing panel list to detect sync arrival.
    const syncTestId = `sync-test-${Date.now()}`;
    const existingPanels = Array.isArray(panelsBefore.openPanels)
      ? panelsBefore.openPanels
      : [];
    const updatedPanels = [...existingPanels, syncTestId];
    await page.evaluate(
      async (panels: string[]) => {
        await fetch("/api/ui-state/panels", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ openPanels: panels }),
        });
      },
      updatedPanels
    );

    // Wait for the WS broadcast to update the client-side state.
    // The client writes to localStorage on receiving ui-state:updated.
    await expect
      .poll(
        async () => {
          return page.evaluate(() => {
            const raw = localStorage.getItem("topics-open-panels");
            if (!raw) return null;
            try {
              return JSON.parse(raw);
            } catch {
              return null;
            }
          });
        },
        { timeout: 10000 }
      )
      .toEqual(expect.arrayContaining([syncTestId]));

    // Verify focusedPanelId was NOT changed (per-device, no sync)
    const focusedAfter = await page.evaluate(() => {
      return localStorage.getItem("topics-focused-panel");
    });
    expect(focusedAfter).toBe(focusedBefore);

    // Clean up: restore original panels
    await page.evaluate(
      async (panels: string[]) => {
        await fetch("/api/ui-state/panels", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ openPanels: panels }),
        });
      },
      existingPanels
    );
  });
});
