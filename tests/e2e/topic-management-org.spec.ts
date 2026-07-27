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
  resetPaneStore,
} from "./helpers/api-fixtures";
import { interceptWebSocket } from "./helpers/ws-helpers";

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

/** Ensure the sezione Chat is expanded and find a topic in the sidebar.
 *  Note: dnd-kit's useSortable overrides role="treeitem" with role="button"
 *  on sortable topic items, so we search for buttons in the sidebar. */
async function ensureTopicVisible(
  page: import("@playwright/test").Page,
  name: RegExp
) {
  // Ensure sezione Chat is expanded
  const chatsSection = page.getByRole("button", { name: /sezione Chat/ });
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

  // Il reset era in UN solo test (TOPIC-10, sotto): serve a tutti. Il pane-store
  // è UNO per l'intera suite seriale, e questi test contano/riordinano righe
  // nella sidebar, che elenca una chat standalone solo se ha un tab aperto —
  // quindi si riparte esattamente dai tre topic del beforeAll, né più né meno.
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [alphaId, betaId, gammaId]);
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

    // Wait for and click "Impostazioni" in the tab context menu
    const settingsMenuItem = page.locator('button').filter({ hasText: /^Impostazioni$/ });
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
    const settingsMenuReload = page.locator('button').filter({ hasText: /^Impostazioni$/ });
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
    // Default sidebar viewMode is 'timeline' → no section-header buttons. Seed
    // grouped view so the collapsible section headers render (beforeAll creates
    // 3 chats, so the sezione Chat exists).
    await page.addInitScript(() => localStorage.setItem('topics-sidebar-state', JSON.stringify({ viewMode: 'grouped', expandedNodes: [], showArchived: false, pinnedItems: [] })));
    // useSidebarState fetches the server `sidebar-state` on mount and OVERRIDES
    // the localStorage seed above (isFromServerRef). The shared test DB usually
    // holds a `timeline` value, so seed grouped on the SERVER too — otherwise no
    // section headers render and the "sezione Chat" button never appears.
    await page.request.put("http://localhost:13334/api/ui-state/sidebar-state", {
      data: { viewMode: "grouped", showArchived: false, expandedNodes: [], pinnedItems: [] },
    });
    await goToApp(page);

    // Locate the sezione Chat button
    const projectsBtn = page
      .getByRole("button", { name: /sezione Chat/ })
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

    // Reset the authoritative pane-store to EXACTLY [alpha, beta] so hydrate yields
    // a clean two-tab layout (one active). In the accumulated shared-DB state Alpha
    // could hydrate as an open/visible pane (or a split alongside Beta) — and the
    // client suppresses the unread badge for a topic whose pane is currently shown,
    // so the injected unread:updated would never paint. With this reset, clicking
    // Beta activates Beta and leaves Alpha an INACTIVE tab (still a sidebar row),
    // which is the precondition the badge assertion needs.
    // Niente `.catch`: un reset che fallisce in silenzio si traveste da
    // asserzione rotta dieci secondi dopo.
    await resetPaneStore(page.request, [alphaId, betaId]);

    // Navigate to the app
    await goToApp(page);

    // Ensure sezione Chat is expanded
    const chatsSection = page.getByRole("button", { name: /sezione Chat/ });
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

    // The unread badge shows the count inside a styled span. Target by aria-label
    // (NotificationBadge renders aria-label=`${count} unread`) — the broad
    // span+hasText:"3" also matched the topic-name span (strict-mode violation).
    const badge = alphaTopic.locator('span[aria-label="3 unread"]');
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

    // Click "Cambia colore" menuitem to open color submenu
    await menu.getByRole("menuitem", { name: /Cambia colore/i }).click();

    // Wait for color submenu to appear
    await expect(menu.getByText("Scegli colore")).toBeVisible({ timeout: 3000 });

    // Click the green color swatch (#059669 = rgb(5, 150, 105))
    await menu.getByRole("button", { name: "Colore #059669" }).click();

    // Context menu should auto-close (handleColorChange calls onClose)
    await expect(menu).toBeHidden({ timeout: 3000 });

    // The colour is DATA, not a sidebar decoration: the redesign dropped the
    // coloured accent from the tree row (nothing under components/Sidebar reads
    // `topic.color` any more — it feeds the pane/settings surfaces instead), so
    // asserting a tinted svg in the row tested an affordance that no longer
    // exists. What the feature must still guarantee is that the pick STICKS.
    // GET /api/topics returns `{ topics: Record<id, Topic>, … }` — a keyed map.
    const colorOf = async () => {
      const res = await page.request.get("http://localhost:13334/api/topics");
      const body = await res.json();
      return body?.topics?.[betaId]?.color;
    };
    await expect.poll(colorOf, {
      message: "the picked colour is persisted server-side",
      timeout: 5000,
    }).toBe("#059669");

    // …and that it survives a reload: reopening the submenu shows THAT swatch
    // as the selected one (ContextMenu marks `topic.color === color` with the
    // scale-110 ring), which is the user-visible proof the value round-tripped.
    await page.reload();
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    const betaAfterReload = await ensureTopicVisible(page, new RegExp(`E2E-Beta-${TS}`));
    await betaAfterReload.click({ button: "right" });
    const menuAfterReload = page.getByRole("menu");
    await expect(menuAfterReload).toBeVisible({ timeout: 5000 });
    await menuAfterReload.getByRole("menuitem", { name: /Cambia colore/i }).click();
    await expect(menuAfterReload.getByText("Scegli colore")).toBeVisible({ timeout: 3000 });
    await expect(
      menuAfterReload.getByRole("button", { name: "Colore #059669" }),
      "the previously picked swatch is marked selected after reload",
    ).toHaveClass(/scale-110/);
  });

  // TOPIC-12 ("drag-reorder using dnd-helpers persists across reload") was
  // deleted with the feature: manual topic drag-reorder is gone from the UI
  // (no DndContext in the sidebar, and `topicsApi.reorder` has zero callers).
  // The POST /api/topics/reorder route still exists server-side but is
  // unreachable from the client. Restore from git history if reorder is
  // re-wired.
});
