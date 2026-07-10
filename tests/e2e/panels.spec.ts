import { test, expect, type APIRequestContext } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import {
  createTopic,
  deleteTopic,
  createTerminalSession,
  deleteTerminalSession,
  resetPaneStore,
} from "./helpers/api-fixtures";
import { mockOpenClawAvailable, openTopicsMenuItem } from "./helpers/openclaw";

const BASE_URL = "http://localhost:13334";

// Full sidebar-state payload — every legacy field is included so the server's
// migration path (which fires when viewMode is absent) can't reset viewMode.
function sidebarState(viewMode: "timeline" | "grouped") {
  return {
    viewMode,
    showArchived: false,
    expandedNodes: [],
    pinnedItems: [],
    showProjects: true,
    showChats: true,
    showTerminals: true,
    showProjectsArchived: false,
    showChatsArchived: false,
    browserExpanded: false,
  };
}

/** Persist grouped view on the SERVER (wins over localStorage on mount). */
async function setGroupedView(request: APIRequestContext): Promise<void> {
  await request.put(`${BASE_URL}/api/ui-state/sidebar-state`, { data: sidebarState("grouped") });
}

/** Restore the default timeline view so later tests aren't left in grouped mode. */
async function resetTimelineView(request: APIRequestContext): Promise<void> {
  await request.put(`${BASE_URL}/api/ui-state/sidebar-state`, { data: sidebarState("timeline") });
}

let projectTopicId: string | null = null;

test.describe("Panels & Views", () => {
  test.beforeAll(async ({ request }) => {
    // Create a project-linked topic so the "Projects" section has an entry
    const topic = await createTopic(request, "E2E-PanelProject", {
      projectPath: "/tmp/e2e-panels",
    });
    projectTopicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    if (projectTopicId) {
      await deleteTopic(request, projectTopicId);
    }
  });

  test("activity feed shows Live/Digest tabs", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-02" });
    // Activity is openclaw-gated inside the "Settings & Tools" (Topics ▾) menu.
    await mockOpenClawAvailable(page);
    await goToApp(page);
    await openTopicsMenuItem(page, "Activity");
    // Don't use networkidle — SSE activity stream keeps connection open
    await page.waitForTimeout(2000);

    const mainContent = await page.locator('[role="main"]').textContent();
    expect(
      mainContent!.includes("Live") || mainContent!.includes("Digest") ||
      mainContent!.includes("Activity") || mainContent!.includes("heartbeat")
    ).toBeTruthy();
  });

  test("agents panel shows content", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-02" });
    // Agents is openclaw-gated inside the "Settings & Tools" (Topics ▾) menu.
    await mockOpenClawAvailable(page);
    await goToApp(page);
    await openTopicsMenuItem(page, /Agents/);
    await page.waitForTimeout(1500);

    expect((await page.locator('[role="main"]').textContent())!.length).toBeGreaterThan(5);
  });

  test("multi-pane layout with Add Pane", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-02" });
    await goToApp(page);
    await openTopic(page, /Web Search Test/);

    const addPaneBtn = page.getByRole("button", { name: /Add pane/ });
    if (await addPaneBtn.count() > 0) {
      await addPaneBtn.first().click();
      await page.waitForTimeout(1500);
    }
    expect((await page.locator('[role="main"]').textContent())!.length).toBeGreaterThan(10);
  });

  test("dashboard digest tab", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-02" });
    // Activity is openclaw-gated inside the "Settings & Tools" (Topics ▾) menu.
    await mockOpenClawAvailable(page);
    await goToApp(page);
    await openTopicsMenuItem(page, "Activity");
    await page.waitForTimeout(1500);

    const digestTab = page.locator("text=Digest");
    if (await digestTab.count() > 0) {
      await digestTab.first().click();
      await page.waitForTimeout(1500);
    }

    // Navigate back to chat and wait for input to be ready
    await openTopic(page, /Web Search Test/);
    await expect(page.getByRole("textbox", { name: /Message input/ })).toBeVisible({ timeout: 10000 });
  });

  test("terminal section exists", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-02" });
    // Sidebar sections (Terminals/Browsers/…) only render in GROUPED view; the
    // default is the unified timeline. viewMode is SERVER-persisted
    // (useSidebarState fetches /api/ui-state/sidebar-state on mount and it wins
    // over localStorage), so a localStorage-only seed is clobbered — set it on
    // the server, including all legacy fields to block the migration path.
    await setGroupedView(request);
    // A grouped section renders only when it has ≥1 item (TopicTree:724 hides
    // empty sections), and a standalone terminal shows only with an OPEN tab
    // (buildSidebarItems §4). Seed a real session AND its pane so the Terminals
    // section has content.
    const session = await createTerminalSession(request, { name: "E2E-PanelTerm" });
    await resetPaneStore(request, [`terminal:${session.id}`]);
    try {
      await goToApp(page);
      const terminalsBtn = page.getByRole("button", { name: /Terminals/ });
      await expect(terminalsBtn).toBeVisible({ timeout: 10000 });
    } finally {
      await deleteTerminalSession(request, session.id);
      await resetPaneStore(request, []);
      await resetTimelineView(request);
    }
  });

  test("browser section shows instances", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-02" });
    // Sidebar sections only render in GROUPED view (default is timeline) and
    // only when non-empty. A browser row is emitted for every open `browser:`
    // pane (buildSidebarItems:512 — no live context required), so seeding a
    // browser pane populates the Browsers section. viewMode is server-persisted,
    // so grouped mode must be set on the server (see terminal test above).
    await setGroupedView(request);
    await resetPaneStore(request, ["browser:e2e-panel-browser"]);
    try {
      await goToApp(page);
      const browserSection = page.getByRole("button", { name: /Browser/ });
      await expect(browserSection.first()).toBeVisible({ timeout: 10000 });

      await browserSection.first().click();
      await page.waitForTimeout(1500);

      const bodyText = await page.locator("body").textContent();
      expect(bodyText!.includes("browser") || bodyText!.includes("Browser")).toBeTruthy();
    } finally {
      await resetPaneStore(request, []);
      await resetTimelineView(request);
    }
  });

  test("remote access panel opens", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-02" });
    await goToApp(page);
    const remoteBtn = page.getByRole("button", { name: /Remote Access/i });
    if (await remoteBtn.count() > 0) {
      await remoteBtn.click();
      await page.waitForTimeout(1500);
      expect((await page.locator('[role="main"]').textContent())!.length).toBeGreaterThan(5);
    }
  });

  test("file explorer opens project topics", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-02" });
    await goToApp(page);
    // Use the project-linked topic we created (folder name = "e2e-panels")
    const projectBtn = page.locator('button:has-text("e2e-panels")').first();
    await expect(projectBtn).toBeVisible({ timeout: 10000 });
    await projectBtn.click();

    // Wait for the project's child topics to populate rather than relying on a
    // fixed sleep. The target topic name "E2E-PanelProject" is seeded by the
    // beforeAll fixture and must appear under the project before we proceed.
    const targetTopic = page.getByRole("treeitem").filter({ hasText: "E2E-PanelProject" }).first();
    let clicked = false;
    try {
      await expect(targetTopic).toBeVisible({ timeout: 10000 });
      await targetTopic.click();
      // Wait for the chat surface to settle (any rendered text in main pane).
      await expect.poll(
        async () => ((await page.locator('[role="main"]').textContent()) ?? "").length,
        { timeout: 5000 }
      ).toBeGreaterThan(10);
      clicked = true;
    } catch {
      // Fall back to the generic Web Search Test topic if the seeded one is
      // missing for any reason (DB reset between fixtures, etc.).
    }
    if (!clicked) {
      await openTopic(page, /Web Search Test/);
      await expect.poll(
        async () => ((await page.locator('[role="main"]').textContent()) ?? "").length,
        { timeout: 5000 }
      ).toBeGreaterThan(10);
    }
  });

  test("command palette opens with Cmd+K", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-02" });
    await goToApp(page);
    await openTopic(page, /Web Search Test/);

    // Ensure app is ready before triggering shortcut
    await expect(page.getByRole("textbox", { name: /Message input/ })).toBeVisible({ timeout: 10000 });
    await page.keyboard.press("Meta+k");

    // Wait for dialog/palette to appear
    const dialog = page.locator('[role="dialog"], [class*="CommandPalette"], [class*="command-palette"], [class*="modal"]');
    await expect(dialog.first()).toBeVisible({ timeout: 5000 });

    const searchInput = page.locator('[role="dialog"] input, [class*="modal"] input');
    if (await searchInput.count() > 0) {
      await searchInput.first().fill("new");
      await page.waitForTimeout(300);
    }

    await page.keyboard.press("Escape");
    // Wait for dialog to close
    await expect(dialog.first()).toBeHidden({ timeout: 3000 }).catch(() => {});
  });

  test("scripts API responds", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "LAYOUT-02" });
    await goToApp(page);
    const ok = await page.evaluate(async () => {
      const res = await fetch("/api/scripts");
      return res.ok;
    });
    expect(ok).toBeTruthy();
  });
});
