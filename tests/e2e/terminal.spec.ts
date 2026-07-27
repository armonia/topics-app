import { expect } from "@playwright/test";
import { test } from "./fixtures/terminal.fixture";
import {
  createTopic,
  deleteTopic,
  listTerminalSessions,
  deleteTerminalSession,
  deleteAllTerminalSessions,
  resetPaneStore,
  resetProjectPanes,
} from "./helpers/api-fixtures";
import { goToApp } from "./helpers";

// The e2e DB persists across runs (DATA_DIR=/tmp/topics-test-data) and the
// per-project pane channel is union-additive on hydrate, so terminal panes
// opened by a prior run — or a prior RETRY of the same test — stay persisted
// under /tmp's `topics-project-panes-<hash>` key and are re-added into a fresh
// page. That made TERM-01 pick up a DEAD stale pane (empty → no prompt) and
// TERM-04 count 3–6 tabs instead of 2. Reset the shared /tmp project layout +
// kill all live sessions before EVERY test in this file so each starts from a
// known-empty terminal state (retry-safe: beforeEach re-runs on each attempt).
// Il reset per-progetto sopra non basta: una pane terminale aperta al livello
// GLOBALE da un altro file (il pane-store è uno solo per tutta la suite seriale)
// sopravvive, e `navigateAndOpenTerminal` vede `xtermAlreadyVisible` → riusa una
// shell morta invece di aprirne una. Sulle tab bar in più, poi, il `.last()` di
// TERM-04/TERM-08 finisce sul gruppo sbagliato. Ogni test qui apre da sé finestra
// progetto e shell partendo dalla sidebar, quindi non c'è nulla da preservare.
test.beforeEach(async ({ request }) => {
  await deleteAllTerminalSessions(request);
  await resetPaneStore(request, []);
  await resetProjectPanes(request, "/tmp");
});

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

    // Expand the sezione Progetti if collapsed
    const projectsSection = page.getByRole("button", {
      name: /sezione Progetti/,
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
    test.info().annotations.push({ type: "spec", description: "TERM-01" });
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
    test.info().annotations.push({ type: "spec", description: "TERM-01" });
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
    test.info().annotations.push({ type: "spec", description: "TERM-01" });
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

  test("TERM-06: terminal resizes when pane dimensions change", async ({
    terminalPage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "TERM-01" });
    await navigateAndOpenTerminal(page, terminalPage);

    // Record initial xterm screen width
    const initialWidth = await page.evaluate(
      () => document.querySelector(".xterm-screen")?.getBoundingClientRect().width,
    );
    expect(initialWidth).toBeTruthy();

    // Resize viewport to a smaller width
    await page.setViewportSize({ width: 800, height: 600 });

    // Wait for xterm to process the resize (fit addon triggers on resize observer)
    await page.waitForTimeout(500);

    // Measure new width
    const newWidth = await page.evaluate(
      () => document.querySelector(".xterm-screen")?.getBoundingClientRect().width,
    );
    expect(newWidth).toBeTruthy();
    expect(newWidth).not.toBe(initialWidth);
  });

  test("TERM-07: terminal preserves scrollback buffer", async ({
    terminalPage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "TERM-01" });
    await navigateAndOpenTerminal(page, terminalPage);

    await terminalPage.focus();

    // Generate enough output to fill visible area and create scrollback
    const marker = `scrollback-end-${Date.now()}`;
    await terminalPage.typeCommand(`for i in $(seq 1 50); do echo line-$i; done && echo ${marker}`);

    // Wait for the last line to confirm command completed
    await terminalPage.waitForOutput(marker);

    // The terminal text should contain earlier lines (scrollback preserved)
    // xterm.js innerText includes the scrollback buffer content
    await expect(async () => {
      const text = await terminalPage.getTerminalText();
      expect(text).toContain("line-50");
    }).toPass({ timeout: 5_000 });
  });

  test("TERM-08: closing terminal tab removes it from tab bar", async ({
    terminalPage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "TERM-01" });
    await navigateAndOpenTerminal(page, terminalPage);

    // Locate the Shell tab in the pane tab bar. Post-redesign the shell tab is
    // auto-named basename(cwd) (server/routes/terminal.ts:1019-1022), never "Shell",
    // so match by the terminal pane-tab testid instead of the literal title.
    const tabBar = page.locator('[data-testid="panel-tab-bar"]').last();
    const shellTab = tabBar.locator('[data-testid^="pane-tab-terminal:"]').first();
    await expect(shellTab).toBeVisible();

    // Hover over the Shell tab to reveal the close button
    await shellTab.hover();

    // Click the close button (X icon that appears on hover)
    const closeBtn = shellTab.locator("button").first();
    await closeBtn.waitFor({ state: "visible", timeout: 5_000 });
    await closeBtn.click();

    // Verify the Shell tab is no longer visible in the tab bar
    await expect(shellTab).not.toBeVisible({ timeout: 5_000 });
  });

  test("TERM-09: terminal handles rapid input", async ({
    terminalPage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "TERM-01" });
    await navigateAndOpenTerminal(page, terminalPage);

    await terminalPage.focus();

    // Type a long string rapidly (5ms between chars)
    const rapidText = "abcdefghijklmnopqrstuvwxyz1234567890";
    const marker = `rapid-${Date.now()}`;
    await page.keyboard.type(`echo ${rapidText} && echo ${marker}`, { delay: 5 });
    await page.keyboard.press("Enter");

    // Wait for marker to confirm command completed
    await terminalPage.waitForOutput(marker);

    // Verify the full string appears in terminal output
    const text = await terminalPage.getTerminalText();
    expect(text).toContain(rapidText);
  });

  test("TERM-10: terminal focus by clicking", async ({
    terminalPage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "TERM-01" });
    await navigateAndOpenTerminal(page, terminalPage);

    // Click somewhere else to unfocus the terminal (e.g., the sidebar)
    const sidebar = page.locator('[data-testid="sidebar"]').or(
      page.locator(".sidebar"),
    ).first();
    if (await sidebar.isVisible()) {
      await sidebar.click({ position: { x: 10, y: 10 } });
    }

    // Click the terminal area to restore focus
    await terminalPage.focus();

    // Type a command to verify focus was restored
    const marker = `focus-test-${Date.now()}`;
    await terminalPage.typeCommand(`echo ${marker}`);

    // Verify the command executed (focus was successfully restored by clicking)
    await terminalPage.waitForOutput(marker);
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
    test.info().annotations.push({ type: "spec", description: "TERM-01" });
    // Set up WS interception BEFORE navigation to capture terminal WS connections
    type WsRoute = {
      close: (options?: { code?: number; reason?: string }) => void | Promise<void>;
    };
    const serverConnections: WsRoute[] = [];
    // We drive the disconnect from the CLIENT side (below), so keep the page-
    // side routes too. Closing the SERVER route does not reliably surface a
    // close event to the browser's WebSocket under Playwright's proxy (the
    // custom close code isn't propagated), so the client never sees the drop
    // and never reconnects. Closing the CLIENT route makes the page's socket
    // fire `onclose` with our non-1000 code — exactly a real network drop —
    // which is what SingleTerminalPane's auto-reconnect keys off.
    const clientConnections: WsRoute[] = [];
    await page.routeWebSocket(/\/ws\/terminal\//, (ws) => {
      const server = ws.connectToServer();
      serverConnections.push(server);
      clientConnections.push(ws);
      // Transparent proxy — pass through all messages
      ws.onMessage((msg) => server.send(msg));
      server.onMessage((msg) => ws.send(msg));
    });

    // Navigate and open terminal
    await goToApp(page);

    // Expand sezione Progetti if collapsed
    const projectsSection = page.getByRole("button", {
      name: /sezione Progetti/,
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

    // Trigger disconnect by closing the CLIENT-side connection with a non-1000
    // code. Code 1000 is treated as a clean PTY-exit and the client will NOT
    // reconnect (SingleTerminalPane.tsx:376-382); 1001 forces auto-reconnect.
    const lastClient = clientConnections[clientConnections.length - 1];
    await lastClient.close({ code: 1001, reason: "e2e-disconnect" });

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
    test.info().annotations.push({ type: "spec", description: "TERM-01" });
    await goToApp(page);

    // Expand sezione Progetti if collapsed
    const projectsSection = page.getByRole("button", {
      name: /sezione Progetti/,
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
    const shellTabs = tabBar.locator('[data-testid^="pane-tab-terminal:"]');
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
