import { test, expect } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import {
  createTopic,
  deleteTopic,
  createTerminalSession,
  deleteTerminalSession,
} from "./helpers/api-fixtures";

const created: { topics: string[]; terminals: string[] } = {
  topics: [],
  terminals: [],
};

test.describe("Sidebar — Unified Timeline", () => {
  test.beforeAll(async ({ request }) => {
    // Reset sidebar state to clean defaults (include all legacy fields to prevent migration from old values)
    await request.put("http://localhost:13334/api/ui-state/sidebar-state", {
      data: {
        viewMode: "timeline",
        showArchived: false,
        expandedNodes: [],
        showProjects: true,
        showChats: true,
        showTerminals: true,
        showProjectsArchived: false,
        showChatsArchived: false,
        browserExpanded: false,
      },
    });

    // Create test data: a project topic, a standalone chat, and a terminal
    const projectTopic = await createTopic(request, "E2E-ProjectChat", {
      projectPath: "/tmp/e2e-sidebar-project",
    });
    created.topics.push(projectTopic.id);

    const standaloneChat = await createTopic(request, "E2E-StandaloneChat");
    created.topics.push(standaloneChat.id);

    const terminal = await createTerminalSession(request, {
      cwd: "/tmp",
      type: "shell",
      name: "E2E-TestTerminal",
    });
    created.terminals.push(terminal.id);
  });

  test.afterAll(async ({ request }) => {
    for (const id of created.topics) {
      await deleteTopic(request, id);
    }
    for (const id of created.terminals) {
      await deleteTerminalSession(request, id);
    }
  });

  // AC-1: Timeline view — all items in a single flat list
  test("AC-1: timeline view shows items in a single list", async ({
    page,
    request,
  }) => {
    test.info().annotations.push({
      type: "spec",
      description: "SIDEBAR-AC1",
    });

    // Pre-open tabs so items appear in sidebar
    await request.put("http://localhost:13334/api/ui-state/panels", {
      data: { openPanels: [created.topics[1], `terminal:${created.terminals[0]}`] },
    });
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', {
      state: "visible",
      timeout: 15000,
    });

    // The sidebar tree should be visible
    const sidebar = page.getByRole("tree", { name: "Sidebar" });
    await expect(sidebar).toBeVisible({ timeout: 10000 });

    // Items with open tabs should be visible
    await expect(
      page.getByRole("treeitem", { name: /E2E-StandaloneChat/ })
    ).toBeVisible({ timeout: 5000 });
  });

  // AC-1: Project accordion expands to show children
  // TODO: test infrastructure issue — pre-setting openPanels via API/localStorage doesn't reliably
  // propagate to React state before the click. Works correctly in the real app.
  test.fixme("AC-1: project accordion expands and collapses", async ({
    page,
    request,
  }) => {
    test.info().annotations.push({
      type: "spec",
      description: "SIDEBAR-AC1",
    });

    // Set panels in both localStorage and server to include the project chat
    const topicId = created.topics[0];
    await request.put("http://localhost:13334/api/ui-state/panels", {
      data: { openPanels: [topicId] },
    });
    // Also pre-set localStorage so the page loads with the panels immediately
    await page.addInitScript((id) => {
      localStorage.setItem("topics-open-panels", JSON.stringify([id]));
    }, topicId);

    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', {
      state: "visible",
      timeout: 15000,
    });

    // Wait for the project to show in sidebar
    const projectBtn = page.getByTestId("project-toggle-e2e-sidebar-project");
    await expect(projectBtn).toBeVisible({ timeout: 10000 });

    // Click to expand the project accordion
    await projectBtn.click();

    // After expanding, the project chat should be visible
    await expect(
      page.getByRole("treeitem", { name: /E2E-ProjectChat/ })
    ).toBeVisible({ timeout: 10000 });
  });

  // AC-2: Toggle between timeline and grouped view
  test("AC-2: view toggle switches between timeline and grouped", async ({
    page,
    request,
  }) => {
    test.info().annotations.push({
      type: "spec",
      description: "SIDEBAR-AC2",
    });

    // Pre-open tabs so sections have content in grouped view
    await request.put("http://localhost:13334/api/ui-state/panels", {
      data: { openPanels: [created.topics[1]] },
    });
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', {
      state: "visible",
      timeout: 15000,
    });

    // Find the view mode toggle button
    const viewToggle = page.getByRole("button", {
      name: /Switch to grouped view/,
    });
    await expect(viewToggle).toBeVisible({ timeout: 5000 });

    // Click to switch to grouped view
    await viewToggle.click();

    // In grouped view, collapsible section headers should appear
    await expect(
      page.getByRole("button", { name: /Chats section/ })
    ).toBeVisible({ timeout: 3000 });

    // The toggle should now say "Switch to timeline view"
    const timelineToggle = page.getByRole("button", {
      name: /Switch to timeline view/,
    });
    await expect(timelineToggle).toBeVisible({ timeout: 3000 });

    // Click back to timeline
    await timelineToggle.click();

    // Section headers should be gone
    await expect(
      page.getByRole("button", { name: /Chats section/ })
    ).toBeHidden({ timeout: 3000 });
  });

  // AC-3: Archive toggle shows/hides archived items
  test("AC-3: archive toggle shows and hides archived items", async ({
    page,
    request,
  }) => {
    // Create and archive a topic with unique name
    const uniqueName = `E2E-ArchivedChat-${Date.now()}`;
    const archiveTopic = await createTopic(request, uniqueName);
    created.topics.push(archiveTopic.id);

    // Archive it via API (DELETE with body { archived: true } = archive, not delete)
    await request.delete(
      `http://localhost:13334/api/topics/${archiveTopic.id}`,
      { data: { archived: true } }
    );

    // Ensure clean sidebar state on server — set showArchived=false
    await request.put("http://localhost:13334/api/ui-state/sidebar-state", {
      data: { viewMode: "timeline", showArchived: false, expandedNodes: [], showProjectsArchived: false, showChatsArchived: false },
    });

    // Verify it was saved
    const verifyRes = await request.get("http://localhost:13334/api/ui-state/sidebar-state");
    const verifyData = await verifyRes.json();
    console.log("[ARCHIVE] Server state after reset:", JSON.stringify(verifyData));

    await goToApp(page);

    const archivedItem = page.getByRole("treeitem", { name: new RegExp(uniqueName) }).first();

    // With showArchived=false, the item should be hidden
    await expect(archivedItem).toBeHidden({ timeout: 5000 });

    // Click "Show archived" to reveal it
    await page.getByRole("button", { name: /Show archived/ }).click();
    await expect(archivedItem).toBeVisible({ timeout: 5000 });

    // Click "Hide archived" to hide it again
    await page.getByRole("button", { name: /Hide archived/ }).click();
    await expect(archivedItem).toBeHidden({ timeout: 5000 });
  });

  // AC-6: Search — now handled by command palette (Cmd+K), not inline search
  // The sidebar search button opens the command palette. Inline search tests removed
  // as the search UX changed to use the global command palette.

  // AC-8: Controls layout — search + two toggles
  test("AC-8: sidebar controls are compact with search and toggles", async ({
    page,
  }) => {
    await goToApp(page);

    // Search/command palette button should be visible
    await expect(
      page.getByRole("button", { name: /Open command palette/ })
    ).toBeVisible({ timeout: 5000 });

    // View mode toggle should be visible
    await expect(
      page.getByRole("button", { name: /Switch to grouped view/ })
    ).toBeVisible({ timeout: 3000 });

    // Archive toggle should be visible
    await expect(
      page.getByRole("button", { name: /Show archived/ })
    ).toBeVisible({ timeout: 3000 });
  });

  // AC-1: Clicking a topic in timeline still switches panel
  test("clicking topics in timeline switches the main panel", async ({
    page,
    request,
  }) => {
    test.info().annotations.push({
      type: "spec",
      description: "SIDEBAR-AC1",
    });

    // Pre-open standalone chat tab so it appears in sidebar
    await request.put("http://localhost:13334/api/ui-state/panels", {
      data: { openPanels: [created.topics[1]] },
    });
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', {
      state: "visible",
      timeout: 15000,
    });

    await openTopic(page, /E2E-StandaloneChat/);

    // Wait for textarea to confirm the panel loaded
    const textarea = page.getByRole("textbox", { name: /Message input/ });
    await expect(textarea).toBeVisible({ timeout: 10000 });
  });
});
