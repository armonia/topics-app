import { expect } from "@playwright/test";
import { test } from "./fixtures/terminal.fixture";
import {
  createTopic,
  deleteTopic,
  listTerminalSessions,
  deleteTerminalSession,
} from "./helpers/api-fixtures";
import { goToApp } from "./helpers";

test.describe.serial("Terminal", () => {
  // Use /tmp which always exists. On macOS, /tmp symlinks to /private/tmp.
  const projectPath = "/tmp";
  const topicName = `e2e-terminal-${Date.now()}`;
  let topicId: string;

  test.beforeAll(async ({ request }) => {
    const topic = await createTopic(request, topicName, {
      projectPath,
    });
    topicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    // Clean up all terminal sessions for this topic
    if (topicId) {
      const sessions = await listTerminalSessions(request, topicId);
      for (const s of sessions) {
        await deleteTerminalSession(request, s.id);
      }
      await deleteTopic(request, topicId);
    }
  });

  /**
   * Navigate to the project and open a terminal via the sidebar "Add to project" > "Shell" dropdown.
   * Returns once xterm.js rows are visible.
   */
  async function navigateAndOpenTerminal(
    page: import("@playwright/test").Page,
    terminalPage: import("./fixtures/terminal.fixture").TerminalPage
  ) {
    await goToApp(page);

    // Expand the Projects section if collapsed
    const projectsSection = page.getByRole("button", {
      name: /Projects section/,
    });
    if ((await projectsSection.count()) > 0) {
      const expanded = await projectsSection.getAttribute("aria-expanded");
      if (expanded === "false") {
        await projectsSection.click();
      }
    }

    // Click the project header to open the project pane
    const projectHeader = page.locator(`button[title="${projectPath}"]`);
    await projectHeader.waitFor({ state: "visible", timeout: 10000 });
    await projectHeader.click();

    // Click the topic to ensure a pane group exists
    const topicItem = page.getByRole("treeitem", { name: topicName });
    await topicItem
      .waitFor({ state: "visible", timeout: 5000 })
      .catch(() => {});
    if (await topicItem.isVisible()) {
      await topicItem.click();
      await page
        .locator('[data-testid="panel-tab-bar"]')
        .last()
        .waitFor({ state: "visible", timeout: 5000 })
        .catch(() => {});
    }

    // Check if terminal is already visible (session may have reconnected)
    const xtermAlreadyVisible = await terminalPage.xtermRows
      .first()
      .isVisible()
      .catch(() => false);
    if (xtermAlreadyVisible) {
      await terminalPage.waitForReady();
      return;
    }

    // Hover over the project row to reveal the "+" button
    await projectHeader.hover();

    // Click the "+" button (title="Add to project")
    const addBtn = projectHeader
      .locator("..")
      .locator('button[title="Add to project"]');
    await addBtn.waitFor({ state: "visible", timeout: 5000 });
    await addBtn.click();

    // Click "Shell" in the dropdown (use exact: true to avoid ambiguity with sidebar items)
    const shellBtn = page.getByRole("button", { name: "Shell", exact: true });
    await shellBtn.waitFor({ state: "visible", timeout: 5000 });
    await shellBtn.click();

    // Wait for xterm.js to render
    await expect(terminalPage.xtermRows.first()).toBeVisible({
      timeout: 15_000,
    });

    // Wait for shell prompt
    await terminalPage.waitForReady();
  }

  test("TERM-01: terminal opens and xterm.js renders with WebSocket connection", async ({
    terminalPage,
    page,
  }) => {
    await navigateAndOpenTerminal(page, terminalPage);

    // Verify xterm.js DOM renderer created .xterm-rows
    await expect(terminalPage.xtermRows.first()).toBeVisible();

    // Verify shell prompt appeared (already verified in navigateAndOpenTerminal)
    // Additional check: terminal tab is visible in the pane tab bar
    const tabBar = page.locator('[data-testid="panel-tab-bar"]').last();
    await expect(tabBar).toBeVisible();
  });

  test("TERM-02: terminal accepts keyboard input and shows output", async ({
    terminalPage,
    page,
  }) => {
    await navigateAndOpenTerminal(page, terminalPage);

    // Click terminal to focus
    await terminalPage.focus();

    // Type a command with a unique marker
    const marker = `e2e-term-${Date.now()}`;
    await terminalPage.typeCommand(`echo ${marker}`);

    // Verify output contains the marker (auto-retry handles async terminal rendering)
    await terminalPage.waitForOutput(marker);
  });

  test("TERM-05: terminal opens with correct project cwd", async ({
    terminalPage,
    page,
  }) => {
    await navigateAndOpenTerminal(page, terminalPage);

    // Click terminal to focus
    await terminalPage.focus();

    // Run pwd to check working directory
    const marker = `pwd-marker-${Date.now()}`;
    await terminalPage.typeCommand(`pwd && echo ${marker}`);

    // Wait for marker to ensure command completed
    await terminalPage.waitForOutput(marker);

    // Verify the project path appears in output
    // On macOS, /tmp is a symlink to /private/tmp, so check for both
    const text = await terminalPage.getTerminalText();
    const hasProjectPath =
      text.includes(projectPath) || text.includes(`/private${projectPath}`);
    expect(hasProjectPath).toBeTruthy();
  });
});

/**
 * TERM-03: WebSocket reconnect test.
 * Requires routeWebSocket BEFORE navigation, so it has its own describe block.
 */
test.describe("Terminal Reconnect", () => {
  const projectPath = "/tmp";
  const topicName = `e2e-term-reconnect-${Date.now()}`;
  let topicId: string;

  test.beforeAll(async ({ request }) => {
    const topic = await createTopic(request, topicName, { projectPath });
    topicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) {
      const sessions = await listTerminalSessions(request, topicId);
      for (const s of sessions) {
        await deleteTerminalSession(request, s.id);
      }
      await deleteTopic(request, topicId);
    }
  });

  test("TERM-03: terminal auto-reconnects after WebSocket disconnect", async ({
    page,
    terminalPage,
  }) => {
    // Set up WS interception BEFORE navigation to capture terminal WS connections
    const serverConnections: { close: () => void }[] = [];
    await page.routeWebSocket(/\/ws\/terminal\//, (ws) => {
      const server = ws.connectToServer();
      serverConnections.push(server);
      // Transparent proxy — pass through all messages
      ws.onMessage((msg) => server.send(msg));
      server.onMessage((msg) => ws.send(msg));
    });

    // Navigate and open terminal
    await goToApp(page);

    // Expand Projects section if collapsed
    const projectsSection = page.getByRole("button", {
      name: /Projects section/,
    });
    if ((await projectsSection.count()) > 0) {
      const expanded = await projectsSection.getAttribute("aria-expanded");
      if (expanded === "false") {
        await projectsSection.click();
      }
    }

    // Click the project header
    const projectHeader = page.locator(`button[title="${projectPath}"]`);
    await projectHeader.waitFor({ state: "visible", timeout: 10000 });
    await projectHeader.click();

    // Click the topic to get a pane group
    const topicItem = page.getByRole("treeitem", { name: topicName });
    await topicItem
      .waitFor({ state: "visible", timeout: 5000 })
      .catch(() => {});
    if (await topicItem.isVisible()) {
      await topicItem.click();
      await page
        .locator('[data-testid="panel-tab-bar"]')
        .last()
        .waitFor({ state: "visible", timeout: 5000 })
        .catch(() => {});
    }

    // Open terminal via sidebar Add to project > Shell
    await projectHeader.hover();
    const addBtn = projectHeader
      .locator("..")
      .locator('button[title="Add to project"]');
    await addBtn.waitFor({ state: "visible", timeout: 5000 });
    await addBtn.click();
    const shellBtn = page.getByRole("button", { name: "Shell", exact: true });
    await shellBtn.waitFor({ state: "visible", timeout: 5000 });
    await shellBtn.click();

    // Wait for xterm to render and shell prompt
    await expect(terminalPage.xtermRows.first()).toBeVisible({
      timeout: 15_000,
    });
    await terminalPage.waitForReady();

    // Verify terminal works before disconnect
    const marker1 = `pre-disconnect-${Date.now()}`;
    await terminalPage.focus();
    await terminalPage.typeCommand(`echo ${marker1}`);
    await terminalPage.waitForOutput(marker1);

    // Capture current server connection count
    const connectionsBefore = serverConnections.length;
    expect(connectionsBefore).toBeGreaterThanOrEqual(1);

    // Trigger disconnect by closing the server-side connection
    const lastServer = serverConnections[serverConnections.length - 1];
    lastServer.close();

    // Wait for client to auto-reconnect — a new server connection should appear
    await expect(async () => {
      expect(serverConnections.length).toBeGreaterThan(connectionsBefore);
    }).toPass({ timeout: 15_000 });

    // Wait for terminal to stabilize after reconnect
    // The PTY process survives the WS disconnect; only the WS link broke
    // After reconnect, the shell is still alive and accepts commands
    await terminalPage.focus();
    const marker2 = `post-reconnect-${Date.now()}`;
    await terminalPage.typeCommand(`echo ${marker2}`);
    await terminalPage.waitForOutput(marker2, 15_000);
  });
});

/**
 * TERM-04: Multiple terminal instances with switching.
 * Tests opening 2 terminal panes and switching between them via PaneTabBar.
 */
test.describe("Terminal Multi-Instance", () => {
  const projectPath = "/tmp";
  const topicName = `e2e-term-multi-${Date.now()}`;
  let topicId: string;

  test.beforeAll(async ({ request }) => {
    const topic = await createTopic(request, topicName, { projectPath });
    topicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) {
      const sessions = await listTerminalSessions(request, topicId);
      for (const s of sessions) {
        await deleteTerminalSession(request, s.id);
      }
      await deleteTopic(request, topicId);
    }
  });

  /**
   * Open a terminal via the sidebar Add to project > Shell dropdown.
   */
  async function openTerminalViaUI(
    page: import("@playwright/test").Page,
    terminalPage: import("./fixtures/terminal.fixture").TerminalPage
  ) {
    const projectHeader = page.locator(`button[title="${projectPath}"]`);
    await projectHeader.hover();
    const addBtn = projectHeader
      .locator("..")
      .locator('button[title="Add to project"]');
    await addBtn.waitFor({ state: "visible", timeout: 5000 });
    await addBtn.click();
    const shellBtn = page.getByRole("button", { name: "Shell", exact: true });
    await shellBtn.waitFor({ state: "visible", timeout: 5000 });
    await shellBtn.click();
    await expect(terminalPage.xtermRows.first()).toBeVisible({
      timeout: 15_000,
    });
    await terminalPage.waitForReady();
  }

  test("TERM-04: multiple terminal instances can be opened and switched", async ({
    terminalPage,
    page,
  }) => {
    await goToApp(page);

    // Expand Projects section if collapsed
    const projectsSection = page.getByRole("button", {
      name: /Projects section/,
    });
    if ((await projectsSection.count()) > 0) {
      const expanded = await projectsSection.getAttribute("aria-expanded");
      if (expanded === "false") {
        await projectsSection.click();
      }
    }

    // Click the project header
    const projectHeader = page.locator(`button[title="${projectPath}"]`);
    await projectHeader.waitFor({ state: "visible", timeout: 10000 });
    await projectHeader.click();

    // Click the topic to get a pane group
    const topicItem = page.getByRole("treeitem", { name: topicName });
    await topicItem
      .waitFor({ state: "visible", timeout: 5000 })
      .catch(() => {});
    if (await topicItem.isVisible()) {
      await topicItem.click();
      await page
        .locator('[data-testid="panel-tab-bar"]')
        .last()
        .waitFor({ state: "visible", timeout: 5000 })
        .catch(() => {});
    }

    // Open first terminal
    await openTerminalViaUI(page, terminalPage);

    // Type unique marker in terminal 1
    await terminalPage.focus();
    const marker1 = `term1-${Date.now()}`;
    await terminalPage.typeCommand(`echo ${marker1}`);
    await terminalPage.waitForOutput(marker1);

    // Open second terminal
    await openTerminalViaUI(page, terminalPage);

    // Type unique marker in terminal 2
    await terminalPage.focus();
    const marker2 = `term2-${Date.now()}`;
    await terminalPage.typeCommand(`echo ${marker2}`);
    await terminalPage.waitForOutput(marker2);

    // Verify there are at least 2 terminal/shell tabs in the pane tab bar
    // Terminal panes have title "Shell" and show in the last panel-tab-bar
    const tabBar = page.locator('[data-testid="panel-tab-bar"]').last();
    // Each pane tab is a div containing a span with the pane title; filter those with "Shell"
    const shellTabs = tabBar.locator('div').filter({ hasText: /^Shell$/ });
    await expect(shellTabs).toHaveCount(2, { timeout: 5000 });

    // Switch to terminal 1 by clicking the first Shell tab
    await shellTabs.first().click();

    // Wait for terminal 1 content to be visible with marker1
    await expect(async () => {
      const text = await terminalPage.getTerminalText();
      expect(text).toContain(marker1);
    }).toPass({ timeout: 10_000 });

    // Switch to terminal 2 by clicking the second Shell tab
    await shellTabs.last().click();

    // Wait for terminal 2 content to be visible with marker2
    await expect(async () => {
      const text = await terminalPage.getTerminalText();
      expect(text).toContain(marker2);
    }).toPass({ timeout: 10_000 });
  });
});
