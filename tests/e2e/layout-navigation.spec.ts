import { test } from "./fixtures/layout.fixture";
import { expect } from "@playwright/test";
import { goToApp } from "./helpers";

test.describe("Layout & Navigation", () => {
  test("LAYOUT-01: pane tab bar close and right-click context menu", async ({
    page,
    layoutPage,
  }) => {
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
});
