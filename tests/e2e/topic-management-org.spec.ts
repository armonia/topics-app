/**
 * Topic Management - Settings & Organization E2E Tests
 *
 * Tests for TOPIC-07 (settings modal), TOPIC-09 (project folders),
 * TOPIC-10 (unread indicators), TOPIC-11 (color customization),
 * TOPIC-12 (drag-reorder).
 *
 * CONVENTION: No waitForTimeout() usage.
 */
import { test, expect } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import {
  createTopic,
  deleteTopic,
} from "./helpers/api-fixtures";
import { interceptWebSocket } from "./helpers/ws-helpers";
import { dndReorder } from "./helpers/dnd-helpers";

const TS = Date.now();

/** Navigate to the app and open a specific topic using search */
async function gotoAndOpenTopic(
  page: import("@playwright/test").Page,
  topicName: RegExp
) {
  await goToApp(page);
  await openTopicViaSearch(page, topicName);
}

/** Open a topic via the sidebar search, then clear the search and ensure the topic tab is active */
async function openTopicViaSearch(
  page: import("@playwright/test").Page,
  name: RegExp
) {
  const searchbox = page.getByRole("searchbox", { name: /Search topics/ });
  const searchText = name.source.replace(/[\\^$.*+?()[\]{}|]/g, "");
  await searchbox.fill(searchText);

  // In search mode, results render as buttons
  const searchResult = page.getByRole("button", { name });
  await searchResult.waitFor({ state: "visible", timeout: 5000 });
  // Double-click to permanently open (single click opens as preview which may not stick)
  await searchResult.dblclick();

  // Clear search to return to normal sidebar view
  await searchbox.fill("");

  // Wait for the main area to be ready
  await page.locator('[role="main"]').waitFor({ state: "visible", timeout: 10000 });

  // Ensure the topic's tab is active by clicking on it in the tab bar
  // The tab text is in the main area header
  const topicTab = page.locator('[role="main"]').getByText(name).first();
  const tabVisible = await topicTab.waitFor({ state: "visible", timeout: 3000 }).then(() => true).catch(() => false);
  if (tabVisible) {
    await topicTab.click();
  }
}

/** Ensure the Chats section is expanded and find a topic in the sidebar.
 *  Note: dnd-kit's useSortable overrides role="treeitem" with role="button"
 *  on sortable topic items, so we search for buttons in the sidebar. */
async function ensureTopicVisible(
  page: import("@playwright/test").Page,
  name: RegExp
) {
  // Ensure Chats section is expanded
  const chatsSection = page.getByRole("button", { name: /Chats section/ });
  if ((await chatsSection.count()) > 0) {
    const expanded = await chatsSection.getAttribute("aria-expanded");
    if (expanded === "false") {
      await chatsSection.click();
    }
  }

  // Find the topic in the sidebar (rendered as button due to dnd-kit sortable)
  // Use CSS attribute selector to match aria-label exactly (avoid matching "Archive E2E-...")
  const sidebar = page.locator('[aria-label="Topics sidebar"]');
  const nameStr = name.source.replace(/[\\^$.*+?()[\]{}|]/g, "");
  const topicItem = sidebar.locator(`[aria-label="${nameStr}"]`);

  await topicItem.waitFor({ state: "visible", timeout: 10000 });
  return topicItem;
}

test.describe("Topic Management - Settings & Organization", () => {
  let alphaId: string;
  let betaId: string;
  let gammaId: string;

  test.beforeAll(async ({ request }) => {
    const alpha = await createTopic(request, `E2E-Alpha-${TS}`);
    const beta = await createTopic(request, `E2E-Beta-${TS}`);
    const gamma = await createTopic(request, `E2E-Gamma-${TS}`);
    alphaId = alpha.id;
    betaId = beta.id;
    gammaId = gamma.id;
  });

  test.afterAll(async ({ request }) => {
    await deleteTopic(request, alphaId).catch(() => {});
    await deleteTopic(request, betaId).catch(() => {});
    await deleteTopic(request, gammaId).catch(() => {});
  });

  test("TOPIC-07: topic settings modal with system prompt and context files", async ({
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "TOPIC-02" });
    await goToApp(page);

    // Click the topic in the sidebar to open it as a panel
    const topicBtn = await ensureTopicVisible(page, new RegExp(`E2E-Alpha-${TS}`));
    await topicBtn.click();

    // Wait for the tab to appear, then click it using evaluate to avoid DOM detachment issues
    await expect(async () => {
      const found = await page.evaluate((ts) => {
        const spans = document.querySelectorAll('[role="main"] span');
        for (const span of spans) {
          if (span.textContent?.includes(`E2E-Alpha-${ts}`)) {
            // Click the parent tab element
            const tab = span.closest('[draggable], [class*="cursor-pointer"]') || span.parentElement;
            if (tab) (tab as HTMLElement).click();
            return true;
          }
        }
        return false;
      }, `${TS}`);
      expect(found).toBe(true);
    }).toPass({ timeout: 5000 });

    // Wait for chat input to confirm the topic is actively shown
    const chatInput = page.locator(`[aria-label*="Message input for E2E-Alpha"]`);
    await expect(chatInput).toBeVisible({ timeout: 10000 });

    // Open settings modal via tab right-click context menu
    const mainArea = page.locator('[role="main"]');
    const topicTabText = mainArea.getByText(new RegExp(`E2E-Alpha-${TS}`)).first();
    await expect(topicTabText).toBeVisible({ timeout: 3000 });
    // Right-click using dispatchEvent to avoid DOM detachment
    await topicTabText.dispatchEvent("contextmenu");

    // Wait for and click "Settings" in the tab context menu
    const settingsMenuItem = page.locator('button').filter({ hasText: /^Settings$/ });
    await expect(settingsMenuItem).toBeVisible({ timeout: 3000 });
    await settingsMenuItem.click();

    // Wait for settings dialog to appear
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // --- System prompt ---
    const promptTextarea = page.getByLabel("System prompt");
    await expect(promptTextarea).toBeVisible();
    await promptTextarea.fill(
      "You are a helpful test assistant for E2E testing."
    );

    // --- Context files ---
    const fileInput = page.getByLabel("Add context file");
    await expect(fileInput).toBeVisible();
    await fileInput.fill("/tmp/test-context.md");
    await fileInput.press("Enter");

    // Verify file appears in the context files list
    const filesList = page.getByLabel("Context files list");
    await expect(filesList).toContainText("test-context.md");

    // Save changes
    const saveBtn = dialog.getByRole("button", { name: /^Save$/i });
    await expect(saveBtn).toBeEnabled();
    await saveBtn.click();

    // Wait for save confirmation -- Save button becomes disabled after save completes
    await expect(saveBtn).toBeDisabled({ timeout: 5000 });

    // Reload and verify persistence
    await page.reload();
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });

    // Re-open the topic by clicking it in sidebar
    const topicBtnReload = await ensureTopicVisible(page, new RegExp(`E2E-Alpha-${TS}`));
    await topicBtnReload.click();

    // Click on the tab to make it active
    await expect(async () => {
      const found = await page.evaluate((ts) => {
        const spans = document.querySelectorAll('[role="main"] span');
        for (const span of spans) {
          if (span.textContent?.includes(`E2E-Alpha-${ts}`)) {
            const tab = span.closest('[draggable], [class*="cursor-pointer"]') || span.parentElement;
            if (tab) (tab as HTMLElement).click();
            return true;
          }
        }
        return false;
      }, `${TS}`);
      expect(found).toBe(true);
    }).toPass({ timeout: 5000 });

    // Wait for chat input
    await expect(page.locator(`[aria-label*="Message input for E2E-Alpha"]`)).toBeVisible({ timeout: 10000 });

    // Re-open settings via tab right-click context menu
    const mainAreaReload = page.locator('[role="main"]');
    const topicTabReload = mainAreaReload.getByText(new RegExp(`E2E-Alpha-${TS}`)).first();
    await expect(topicTabReload).toBeVisible({ timeout: 3000 });
    await topicTabReload.dispatchEvent("contextmenu");
    const settingsMenuReload = page.locator('button').filter({ hasText: /^Settings$/ });
    await expect(settingsMenuReload).toBeVisible({ timeout: 3000 });
    await settingsMenuReload.click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 5000 });

    // Verify system prompt persisted
    await expect(page.getByLabel("System prompt")).toHaveValue(
      "You are a helpful test assistant for E2E testing."
    );

    // Verify context file persisted
    await expect(page.getByLabel("Context files list")).toContainText(
      "test-context.md"
    );
  });

  test("TOPIC-09: project folder expand and collapse", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "TOPIC-02" });
    await goToApp(page);

    // Locate the Projects section button
    const projectsBtn = page
      .getByRole("button", { name: /Projects/ })
      .first();
    await expect(projectsBtn).toBeVisible({ timeout: 10000 });

    // Check initial expanded state
    const isExpanded = await projectsBtn.getAttribute("aria-expanded");

    if (isExpanded === "false") {
      // Expand it
      await projectsBtn.click();
    }

    // After expanding, verify at least one project item is visible
    // Projects render as treeitems or clickable items under the projects section
    const projectItems = page.locator(
      '[data-testid="sidebar-projects-section"] [role="treeitem"], [data-testid="sidebar-projects-section"] button'
    );
    // If no data-testid, try broader approach: look for project names after the Projects header
    const anyProjectItem = page
      .getByRole("treeitem")
      .filter({ hasText: /topics-app|project/i });

    // Either specific project items exist or there are treeitem elements visible
    const hasProjectItems =
      (await projectItems.count()) > 0 || (await anyProjectItem.count()) > 0;

    if (hasProjectItems) {
      // Collapse the section
      await projectsBtn.click();
      // Verify the section is collapsed (aria-expanded=false)
      await expect(projectsBtn).toHaveAttribute("aria-expanded", "false");

      // Expand again
      await projectsBtn.click();
      await expect(projectsBtn).toHaveAttribute("aria-expanded", "true");
    } else {
      // If no projects exist, at least verify the section toggles
      // Collapse
      await projectsBtn.click();
      await expect(projectsBtn).toHaveAttribute("aria-expanded", "false");
      // Expand
      await projectsBtn.click();
      await expect(projectsBtn).toHaveAttribute("aria-expanded", "true");
    }
  });

  test("TOPIC-10: unread indicator via WebSocket mock", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "TOPIC-02" });
    // Intercept WebSocket BEFORE page.goto() — keeps real connection alive + allows injection
    const ws = await interceptWebSocket(page);

    // Navigate to the app
    await goToApp(page);

    // Ensure Chats section is expanded
    const chatsSection = page.getByRole("button", { name: /Chats section/ });
    if ((await chatsSection.count()) > 0) {
      const expanded = await chatsSection.getAttribute("aria-expanded");
      if (expanded === "false") {
        await chatsSection.click();
      }
    }

    // Click on Beta topic to make it focused (so Alpha is unfocused and can show unread badge)
    const betaTopic = page.getByRole("treeitem", { name: new RegExp(`E2E-Beta-${TS}`) });
    await betaTopic.waitFor({ state: "visible", timeout: 10000 });
    await betaTopic.click();
    await page.locator('[role="main"]').waitFor({ state: "visible", timeout: 5000 });

    // Inject unread:updated event for Alpha topic via intercepted WebSocket
    ws.send({
      type: "unread:updated",
      topicId: alphaId,
      unreadCount: 3,
    });

    // Verify unread badge appears on Alpha topic (which is visible but not focused)
    const alphaTopic = page.getByRole("treeitem", { name: new RegExp(`E2E-Alpha-${TS}`) });
    await alphaTopic.waitFor({ state: "visible", timeout: 10000 });

    // The unread badge shows the count inside a styled span
    const badge = alphaTopic.locator("span").filter({ hasText: "3" });
    await expect(badge).toBeVisible({ timeout: 5000 });
  });

  test("TOPIC-11: color customization via context menu persists", async ({
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "TOPIC-02" });
    // Navigate to app and find Beta topic
    await goToApp(page);
    const betaTopic = await ensureTopicVisible(page, new RegExp(`E2E-Beta-${TS}`));

    // Right-click to open context menu
    await betaTopic.click({ button: "right" });
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible({ timeout: 5000 });

    // Click "Change color" menuitem to open color submenu
    await menu.getByRole("menuitem", { name: /Change color/i }).click();

    // Wait for color submenu to appear
    await expect(menu.getByText("Choose color")).toBeVisible({ timeout: 3000 });

    // Click the green color swatch (#059669 = rgb(5, 150, 105))
    await menu.getByRole("button", { name: "Color #059669" }).click();

    // Context menu should auto-close (handleColorChange calls onClose)
    await expect(menu).toBeHidden({ timeout: 3000 });

    // Click the topic to focus it (shows accent border with topic color)
    const betaAfterColor = await ensureTopicVisible(page, new RegExp(`E2E-Beta-${TS}`));
    await betaAfterColor.click();

    // Verify accent border color: #059669 = rgb(5, 150, 105)
    const accentBorder = betaAfterColor.locator('div[style*="background"]').first();
    await expect(accentBorder).toBeVisible({ timeout: 5000 });
    await expect(accentBorder).toHaveCSS("background-color", "rgb(5, 150, 105)");

    // Reload and verify persistence
    await page.reload();
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    const betaAfterReload = await ensureTopicVisible(page, new RegExp(`E2E-Beta-${TS}`));

    // Click to focus again to show the accent border
    await betaAfterReload.click();
    const accentAfterReload = betaAfterReload.locator('div[style*="background"]').first();
    await expect(accentAfterReload).toBeVisible({ timeout: 5000 });
    await expect(accentAfterReload).toHaveCSS("background-color", "rgb(5, 150, 105)");
  });

  test("TOPIC-12: drag-reorder using dnd-helpers persists across reload", async ({
    page, request,
  }) => {
    test.info().annotations.push({ type: "spec", description: "TOPIC-02" });
    await goToApp(page);

    // Ensure test topics are visible in sidebar and scrolled into view
    const alpha = await ensureTopicVisible(page, new RegExp(`E2E-Alpha-${TS}`));
    const gamma = await ensureTopicVisible(page, new RegExp(`E2E-Gamma-${TS}`));
    // Scroll both elements into viewport for mouse events to work
    await alpha.scrollIntoViewIfNeeded();
    await gamma.scrollIntoViewIfNeeded();

    // Helper to get VISUAL order of our E2E test topics (sorted by Y position)
    // dnd-kit uses CSS transforms, so DOM order differs from visual order
    const getTopicOrder = async () => {
      return page.evaluate((ts) => {
        const sidebar = document.querySelector('[aria-label="Topics sidebar"]');
        if (!sidebar) return [];
        const all = sidebar.querySelectorAll('[aria-label]');
        const topics: { name: string; y: number }[] = [];
        for (const el of all) {
          const label = el.getAttribute('aria-label') || '';
          if (label.startsWith('E2E-') && label.includes(ts)) {
            const rect = el.getBoundingClientRect();
            topics.push({ name: label, y: rect.y });
          }
        }
        // Sort by visual Y position (top to bottom)
        return topics.sort((a, b) => a.y - b.y).map(t => t.name);
      }, `${TS}`);
    };

    const initialOrder = await getTopicOrder();
    expect(initialOrder.length).toBeGreaterThanOrEqual(3);

    // Set up a response listener BEFORE the drag to verify API call fires
    const reorderPromise = page.waitForResponse(
      (resp) => resp.url().includes("/api/topics/reorder") && resp.status() === 200,
      { timeout: 10000 }
    );

    // Perform drag: move Alpha below Gamma using dnd-helpers (per D-09)
    await dndReorder(page, alpha, gamma, "below");

    // Verify the reorder API was called successfully
    const reorderResponse = await reorderPromise;
    expect(reorderResponse.ok()).toBeTruthy();

    // Verify visual DOM order changed after drag
    const postDragOrder = await getTopicOrder();
    expect(postDragOrder).not.toEqual(initialOrder);

    // Assert Alpha now appears after Gamma visually
    const alphaIdx = postDragOrder.findIndex(n => n.includes('Alpha'));
    const gammaIdx = postDragOrder.findIndex(n => n.includes('Gamma'));
    expect(alphaIdx).toBeGreaterThan(gammaIdx);

    // Verify the reorder was persisted server-side
    // Use API to check that sortOrder values were set
    const topicsResp = await request.get("http://localhost:13334/api/topics", {
      ignoreHTTPSErrors: true,
    });
    const topicsData = await topicsResp.json() as { topics: Record<string, { sortOrder?: number }> };
    const alphaSortOrder = topicsData.topics[alphaId]?.sortOrder;
    const gammaSortOrder = topicsData.topics[gammaId]?.sortOrder;
    // After drag-reorder, the sortOrder values should have been updated
    // (the exact new order depends on drag behavior, but sortOrders should be distinct)
    expect(alphaSortOrder).toBeDefined();
    expect(gammaSortOrder).toBeDefined();
    expect(alphaSortOrder).not.toBe(gammaSortOrder);

    // Reload and verify visual order persists
    await page.reload();
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: 'visible', timeout: 15000 });
    await ensureTopicVisible(page, new RegExp(`E2E-Alpha-${TS}`));

    const postReloadOrder = await getTopicOrder();
    const alphaIdxReload = postReloadOrder.findIndex(n => n.includes('Alpha'));
    const gammaIdxReload = postReloadOrder.findIndex(n => n.includes('Gamma'));
    expect(alphaIdxReload).toBeGreaterThan(gammaIdxReload);
  });
});
