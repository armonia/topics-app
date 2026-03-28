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
