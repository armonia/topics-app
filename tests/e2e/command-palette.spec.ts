import { expect } from "@playwright/test";
import { test } from "./fixtures/command-palette.fixture";
import { createTopic, cleanupAll, deleteTopic } from "./helpers/api-fixtures";

test.describe("Command Palette", () => {
  const TS = Date.now();
  const topicIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    const alpha = await createTopic(request, `E2E-CmdAlpha-${TS}`);
    const beta = await createTopic(request, `E2E-CmdBeta-${TS}`);
    const gamma = await createTopic(request, `E2E-CmdGamma-${TS}`);
    topicIds.push(alpha.id, beta.id, gamma.id);
  });

  test.afterAll(async ({ request }) => {
    await cleanupAll(request, { topics: topicIds });
  });

  // CMD-01: Cmd+K opens command palette with focused search input
  test("CMD-01: Cmd+K opens command palette with focused search input", async ({
    commandPalettePage,
    page,
  }) => {
    await page.goto("/", { waitUntil: "networkidle" });

    await commandPalettePage.open();

    // Overlay should be visible with proper dialog role
    await expect(commandPalettePage.overlay).toBeVisible();
    await expect(commandPalettePage.overlay).toHaveAttribute("role", "dialog");

    // Search input should be focused
    await expect(commandPalettePage.searchInput).toBeFocused();

    // Clean up
    await commandPalettePage.close();
  });

  // CMD-07: Escape closes the palette and removes it from DOM
  test("CMD-07: Escape closes palette and removes it from DOM", async ({
    commandPalettePage,
    page,
  }) => {
    await page.goto("/", { waitUntil: "networkidle" });

    // Open palette and verify it's visible
    await commandPalettePage.open();
    await expect(commandPalettePage.overlay).toBeVisible();

    // Close with Escape
    await commandPalettePage.close();

    // Palette should be removed from DOM (returns null when !isOpen)
    await expect(commandPalettePage.overlay).toBeHidden();
  });

  // CMD-06: Keyboard navigation with arrow keys moves aria-selected
  test("CMD-06: arrow keys move aria-selected between palette options", async ({
    commandPalettePage,
    page,
  }) => {
    await page.goto("/", { waitUntil: "networkidle" });

    await commandPalettePage.open();
    await expect(commandPalettePage.overlay).toBeVisible();

    // First item (index 0) should have aria-selected=true
    const firstItem = commandPalettePage.overlay.locator('[data-cmd-idx="0"]');
    await expect(firstItem).toHaveAttribute("aria-selected", "true");

    // Press ArrowDown - second item should become selected
    await page.keyboard.press("ArrowDown");
    const secondItem = commandPalettePage.overlay.locator('[data-cmd-idx="1"]');
    await expect(secondItem).toHaveAttribute("aria-selected", "true");
    await expect(firstItem).toHaveAttribute("aria-selected", "false");

    // Press ArrowUp - first item should be selected again
    await page.keyboard.press("ArrowUp");
    await expect(firstItem).toHaveAttribute("aria-selected", "true");
    await expect(secondItem).toHaveAttribute("aria-selected", "false");

    // Clean up
    await commandPalettePage.close();
  });

  // CMD-02: Topic search filters results and navigates to selected topic
  test("CMD-02: topic search filters and navigates to selected topic", async ({
    commandPalettePage,
    page,
  }) => {
    await page.goto("/", { waitUntil: "networkidle" });

    // Search for a specific topic by partial name
    await commandPalettePage.search("CmdAlpha");

    // Matching topic should be visible
    const alphaOption = commandPalettePage.overlay.getByRole("option", {
      name: new RegExp(`E2E-CmdAlpha-${TS}`),
    });
    await expect(alphaOption).toBeVisible();

    // Non-matching topics should be hidden/filtered out
    const betaOption = commandPalettePage.overlay.getByRole("option", {
      name: new RegExp(`E2E-CmdBeta-${TS}`),
    });
    await expect(betaOption).toBeHidden();

    // Select the matching result by pressing Enter (first navigate down to it if needed)
    await alphaOption.click();

    // Palette should close after selection
    await expect(commandPalettePage.overlay).toBeHidden();

    // Verify topic was navigated to - the topic name should appear in main content
    await expect(page.getByRole("main")).toContainText("E2E-CmdAlpha", {
      timeout: 15000,
    });
  });

  // CMD-03: Execute actions - theme toggle and new chat
  test("CMD-03: theme toggle changes document class and new chat creates topic", async ({
    commandPalettePage,
    page,
    request,
  }) => {
    await page.goto("/", { waitUntil: "networkidle" });

    // --- Part A: Theme toggle ---
    // Theme cycles: system -> light -> dark -> system
    // We need to verify the toggle action works. First, force a known state,
    // then toggle and check the result.
    const wasDark = await page.evaluate(() =>
      document.documentElement.classList.contains("dark")
    );

    // Open palette and find theme action
    await commandPalettePage.open();
    await expect(commandPalettePage.overlay).toBeVisible();
    await expect(commandPalettePage.searchInput).toBeFocused();

    // Theme action should be visible (label varies by current mode)
    const themeOption = commandPalettePage.overlay.getByRole("option", {
      name: /Switch to|Toggle Theme/,
    });
    await expect(themeOption).toBeVisible();

    // Read the theme action label to understand current state
    const themeLabel = await themeOption.innerText();

    // Execute theme toggle
    await themeOption.click();

    // Palette should close
    await expect(commandPalettePage.overlay).toBeHidden();

    // If label said "Switch to Dark Mode" (was light), dark class should now be present
    // If label said "Switch to Light Mode" (was dark), dark class should now be absent
    // If label said "Toggle Theme" (was system), mode changed to light
    if (themeLabel.includes("Switch to Dark")) {
      await expect(async () => {
        const isDark = await page.evaluate(() =>
          document.documentElement.classList.contains("dark")
        );
        expect(isDark).toBe(true);
      }).toPass({ timeout: 3000 });
    } else if (themeLabel.includes("Switch to Light")) {
      await expect(async () => {
        const isDark = await page.evaluate(() =>
          document.documentElement.classList.contains("dark")
        );
        expect(isDark).toBe(false);
      }).toPass({ timeout: 3000 });
    } else {
      // "Toggle Theme" means system mode - toggling goes to light
      // If system was dark, going to light means dark class removed
      // If system was light, going to light means no visible change in class
      // Either way, the action executed successfully (palette closed)
      // We can verify by toggling again to reach dark mode
      await commandPalettePage.open();
      await expect(commandPalettePage.overlay).toBeVisible();
      // Now should show "Switch to Dark Mode" (we're in light mode)
      const themeOption2 = commandPalettePage.overlay.getByRole("option", {
        name: /Switch to Dark/,
      });
      await expect(themeOption2).toBeVisible();
      await themeOption2.click();
      await expect(commandPalettePage.overlay).toBeHidden();
      // Now dark class should be present
      await expect(async () => {
        const isDark = await page.evaluate(() =>
          document.documentElement.classList.contains("dark")
        );
        expect(isDark).toBe(true);
      }).toPass({ timeout: 3000 });
    }

    // --- Part B: New Chat ---
    // New Chat without a project creates a draft pane (no API call until first message)
    // Count open pane tabs before
    const tabCountBefore = await page
      .locator('[role="main"] [role="region"]')
      .count();

    // Open palette and find New Chat action
    await commandPalettePage.open();
    await expect(commandPalettePage.overlay).toBeVisible();

    // Use specific text to match the action (not topic entries also named "New Chat")
    const newChatOption = commandPalettePage.overlay.getByRole("option", {
      name: /New Chat.*Create a new topic/,
    });
    await expect(newChatOption).toBeVisible();

    // Execute New Chat action
    await newChatOption.click();

    // Palette should close
    await expect(commandPalettePage.overlay).toBeHidden();

    // A new draft pane should open - verify by checking for the "New Chat" panel
    // or the "Start a conversation" welcome text in a new empty pane
    await expect(
      page.getByText("Start a conversation")
    ).toBeVisible({ timeout: 10000 });

    // Restore to system theme by toggling until we see "Toggle Theme" (system mode)
    // or just toggle once to move away from dark
    await commandPalettePage.open();
    await expect(commandPalettePage.overlay).toBeVisible();
    const restoreOption = commandPalettePage.overlay.getByRole("option", {
      name: /Switch to|Toggle Theme/,
    });
    await expect(restoreOption).toBeVisible();
    await restoreOption.click();
    await expect(commandPalettePage.overlay).toBeHidden();
  });
});
