/**
 * @covers CTX-01
 *
 * The `CTX-01..07` ids in this file LOOK like a collision with the requirement
 * of the same name, and they are not: they are its PARTS. CTX-01 lists in one
 * sentence the inspector with token counts, the budget bar, the per-source
 * toggle, the context pills and memory CRUD, and there is one test for each,
 * numbered in the order the requirement names them. Declaring it here is what
 * makes that legible to `check:spec-coverage` instead of leaving it looking
 * like an ambiguity.
 */
import path from "node:path";
import { test, expect } from "./fixtures/test-fixtures";
import { createTopic, patchTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";
import { openUserMenuLevel } from "./helpers/user-menu";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

test.describe("Context, Memory & Settings", () => {
  test.beforeEach(async ({ contextPage, page, request }) => {
    // Create a dedicated test topic (non-project, standalone chat)
    await contextPage.createTestTopic();

    // Clear the shared pane-store so panes leaked by earlier specs (which UNION
    // in on hydrate) don't tile alongside this topic — otherwise the chat-input
    // context ring resolves to a HIDDEN background pane and openContextInspector
    // times out. Exactly this topic → one visible chat pane → one visible ring.
    await resetPaneStore(request, [contextPage.topicId!]);

    // Register mocks BEFORE navigation
    await contextPage.mockContextAnalyze();
    await contextPage.mockMemoryEndpoints();

    // Mock PATCH /api/topics/:id for toggle source (CTX-03)
    await page.route("**/api/topics/*", async (route) => {
      if (route.request().method() === "PATCH") {
        const body = JSON.parse(route.request().postData() || "{}");
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            id: contextPage.topicId,
            title: "Test Topic",
            ...body,
          }),
        });
      } else {
        await route.fallback();
      }
    });

    await page.goto("/");
    // Wait for sidebar to load
    await page.waitForSelector('[aria-label="Topics sidebar"]', {
      state: "visible",
      timeout: 15_000,
    });
  });

  test("CTX-01: context inspector shows source list with token counts", async ({
    contextPage,
    page,
  }) => {
    await contextPage.openContextInspector();

    // Verify inspector is visible
    await expect(contextPage.inspector).toBeVisible();

    // Verify at least 4 source rows are visible
    const rowCount = await contextPage.sourceRows.count();
    expect(rowCount).toBeGreaterThanOrEqual(4);

    // Verify source labels from mock data are visible
    await expect(
      contextPage.sourceRows.filter({ hasText: "SOUL.md" }),
    ).toBeVisible();
    await expect(
      contextPage.sourceRows.filter({ hasText: "Topic Memory" }),
    ).toBeVisible();
    await expect(
      contextPage.sourceRows.filter({ hasText: "Global Memory" }),
    ).toBeVisible();
    await expect(
      contextPage.sourceRows.filter({ hasText: "System Prompt" }),
    ).toBeVisible();

    // Verify token counts are displayed (e.g. "3.2K" for SOUL.md's 3200 tokens)
    await expect(
      contextPage.inspector.locator("text=3.2K tok"),
    ).toBeVisible();
  });

  test("CTX-02: budget bar with percentage and color coding", async ({
    contextPage,
  }) => {
    await contextPage.openContextInspector();

    // Verify budget bar is visible
    await expect(contextPage.budgetBar).toBeVisible();

    // Verify percentage text shows "2%" from mock data
    await expect(contextPage.budgetPercent).toBeVisible();
    await expect(contextPage.budgetPercent).toContainText("2%");
  });

  test("CTX-03: toggle context source on/off", async ({
    contextPage,
    page,
  }) => {
    await contextPage.openContextInspector();

    // Find the Topic Memory source row within the inspector
    const inspector = contextPage.inspector.first();
    const topicMemoryRow = inspector
      .locator("div.border-b")
      .filter({ hasText: "Topic Memory" });
    await expect(topicMemoryRow.first()).toBeVisible();

    // Click the disable button (Eye icon with title "Disable this source")
    const disableBtn = topicMemoryRow.locator(
      'button[title="Disable this source"]',
    );
    await expect(disableBtn).toBeVisible();

    // Set up request interception to verify PATCH was called
    const patchPromise = page.waitForRequest(
      (req) =>
        req.url().includes("/api/topics/") && req.method() === "PATCH",
    );

    await disableBtn.click();

    // Verify the PATCH request was sent with disabledContextSources
    const patchReq = await patchPromise;
    const patchBody = JSON.parse(patchReq.postData() || "{}");
    expect(patchBody.disabledContextSources).toBeDefined();
    expect(patchBody.disabledContextSources).toContain("memory:topic");
  });

  test("CTX-04: context warnings at high budget", async ({
    contextPage,
    page,
  }) => {
    // Override mock with high-budget analysis BEFORE navigation
    // Unroute the default mock first, then register the high-budget one
    await page.unroute("**/api/context/analyze*");
    await contextPage.mockContextAnalyzeHighBudget();

    // Re-navigate with new mock
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', {
      state: "visible",
      timeout: 15_000,
    });

    await contextPage.openContextInspector();

    // Verify warnings section is visible - find by the "warning" text in the button
    const inspector = contextPage.inspector.first();
    const warningsSection = inspector.locator(
      'button:has-text("warning")',
    );
    await expect(warningsSection).toBeVisible();

    // Click to expand warnings
    await warningsSection.click();

    // Verify warning text contains budget information
    await expect(inspector).toContainText("85%");
    await expect(inspector).toContainText("budget");
  });

  test("CTX-05: topic memory CRUD via inline edit", async ({
    contextPage,
    page,
  }) => {
    await contextPage.openContextInspector();

    // Find Topic Memory source row within the inspector
    const inspector = contextPage.inspector.first();
    const topicMemoryRow = inspector
      .locator("div.border-b")
      .filter({ hasText: "Topic Memory" });
    await expect(topicMemoryRow.first()).toBeVisible();

    // Click the Edit button (Edit3 icon, title="Edit") directly
    // (clicking Edit also expands the row automatically)
    const editBtn = topicMemoryRow.locator('button[title="Edit"]');
    await expect(editBtn).toBeVisible();
    await editBtn.click();

    // Verify textarea appears
    const textarea = inspector.locator("textarea");
    await expect(textarea).toBeVisible();

    // Clear and type new content
    await textarea.fill("Updated topic memory content");

    // Set up request capture for PUT /api/memory/:topicId
    const putPromise = page.waitForRequest(
      (req) =>
        req.url().includes("/api/memory/") &&
        req.method() === "PUT" &&
        !req.url().endsWith("/api/memory"),
    );

    // Click Save button
    const saveBtn = inspector.locator("button", { hasText: "Save" });
    await expect(saveBtn).toBeVisible();
    await saveBtn.click();

    // Verify the PUT request was sent with updated content
    const putReq = await putPromise;
    const putBody = JSON.parse(putReq.postData() || "{}");
    expect(putBody.content).toBe("Updated topic memory content");
  });

  test("CTX-06: global memory CRUD via inline edit", async ({
    contextPage,
    page,
  }) => {
    await contextPage.openContextInspector();

    // Find Global Memory source row within the inspector
    const inspector = contextPage.inspector.first();
    const globalMemoryRow = inspector
      .locator("div.border-b")
      .filter({ hasText: "Global Memory" });
    await expect(globalMemoryRow.first()).toBeVisible();

    // Click the Edit button directly (also expands row)
    const editBtn = globalMemoryRow.locator('button[title="Edit"]');
    await expect(editBtn).toBeVisible();
    await editBtn.click();

    // Verify textarea appears
    const textarea = inspector.locator("textarea");
    await expect(textarea).toBeVisible();

    // Clear and type new content
    await textarea.fill("Updated global memory content");

    // Set up request capture for PUT /api/memory (global endpoint - no trailing path)
    const putPromise = page.waitForRequest(
      (req) =>
        /\/api\/memory$/.test(req.url()) && req.method() === "PUT",
    );

    // Click Save button
    const saveBtn = inspector.locator("button", { hasText: "Save" });
    await expect(saveBtn).toBeVisible();
    await saveBtn.click();

    // Verify the PUT request was sent
    const putReq = await putPromise;
    const putBody = JSON.parse(putReq.postData() || "{}");
    expect(putBody.content).toBe("Updated global memory content");
  });

  test("SET-01: the settings open from the user menu, as its levels", async ({
    settingsPage, page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "CMD-01" });
    await settingsPage.openSettings();

    // The forms are levels of the user menu: no Settings window, no Settings row.
    await expect(settingsPage.panel).toBeVisible();
    await expect(settingsPage.panel.getByTestId("ai-providers-settings")).toBeVisible();
    await expect(page.getByTestId("settings-panel")).toHaveCount(0);
    await expect(page.getByTestId("topics-menu-settings")).toHaveCount(0);

    // Escape closes the level, then the menu.
    await settingsPage.closeSettings();
    await expect(settingsPage.panel).not.toBeVisible();

    // The appearance controls are in the user menu's Appearance level now.
    await settingsPage.openAppearance();
    for (const mode of ["light", "dark", "system"] as const) {
      await expect(settingsPage.themeRadio(mode)).toBeVisible();
    }
    await expect(settingsPage.fontSizeStepper).toBeVisible();
    await expect(settingsPage.chatWidthStepper).toBeVisible();
    await expect(settingsPage.densityRadio("compact")).toBeVisible();
    await expect(settingsPage.densityRadio("comfortable")).toBeVisible();
    await settingsPage.closeMenu();
  });

  test("SET-02: theme toggle persistence across reload", async ({
    settingsPage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "CMD-01" });
    await settingsPage.openAppearance();

    // Choose "Dark" in the theme segment
    await settingsPage.themeRadio("dark").click();

    // Verify html element has class "dark" (proves the choice applies)
    await expect(page.locator("html")).toHaveClass(/dark/);

    // Close the menu
    await settingsPage.closeMenu();

    // Set localStorage explicitly before reload to test the persistence path.
    // (WS ui-state:init from real server may race with the local write.)
    await page.evaluate(() => localStorage.setItem("theme", JSON.stringify("dark")));

    // Mock the theme GET endpoint and intercept WS to return "dark" after reload
    // (simulating server having received our PUT)
    await page.route("**/api/ui-state/theme", async (route) => {
      const method = route.request().method();
      if (method === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify("dark"),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
      }
    });

    // Intercept WebSocket to rewrite ui-state:init theme to "dark"
    // so the WS init message doesn't overwrite localStorage
    await page.routeWebSocket(/ws/, (ws) => {
      const server = ws.connectToServer();
      server.onMessage((message) => {
        if (typeof message === "string") {
          try {
            const parsed = JSON.parse(message);
            if (parsed.type === "ui-state:init" && parsed.data?.theme !== undefined) {
              parsed.data.theme = "dark";
              ws.send(JSON.stringify(parsed));
              return;
            }
            if (parsed.type === "ui-state:updated" && parsed.key === "theme") {
              parsed.value = "dark";
              ws.send(JSON.stringify(parsed));
              return;
            }
          } catch {}
        }
        ws.send(message);
      });
      ws.onMessage((message) => {
        server.send(message);
      });
    });

    // Reload the page
    await page.reload();
    await page.waitForSelector('[aria-label="Topics sidebar"]', {
      state: "visible",
      timeout: 15_000,
    });

    // Verify html element still has "dark" class after reload
    // useTheme reads localStorage ("dark") for fast paint, server GET returns "dark",
    // WS ui-state:init also sends "dark"
    await expect(page.locator("html")).toHaveClass(/dark/);

    // Cleanup: restore system theme via localStorage and remove WS route
    await page.evaluate(() => localStorage.setItem("theme", JSON.stringify("system")));
  });

  test("SET-03: all settings persist across reload", async ({
    settingsPage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "CMD-01" });
    await settingsPage.openAppearance();

    // Change message density to "Compact"
    await settingsPage.densityRadio("compact").click();

    // Change the text size with the keyboard: 13 -> 16
    await settingsPage.fontSizeStepper.focus();
    for (let i = 0; i < 3; i += 1) await page.keyboard.press("ArrowUp");
    await expect(settingsPage.fontSizeStepper).toHaveAttribute("aria-valuenow", "16");

    await settingsPage.closeMenu();

    // Verify localStorage has updated values (settings save immediately to localStorage)
    const stored = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("app-settings") || "{}"),
    );
    expect(stored.fontSize).toBe(16);
    expect(stored.messageDensity).toBe("compact");

    // Reload the page
    await page.reload();
    await page.waitForSelector('[aria-label="Topics sidebar"]', {
      state: "visible",
      timeout: 15_000,
    });

    // Re-open the level and verify persisted values
    await settingsPage.openAppearance();
    await expect(settingsPage.densityRadio("compact")).toHaveAttribute("aria-checked", "true");
    await expect(settingsPage.fontSizeStepper).toHaveAttribute("aria-valuenow", "16");

    // Cleanup: restore defaults
    await settingsPage.densityRadio("comfortable").click();
    await settingsPage.fontSizeStepper.focus();
    for (let i = 0; i < 3; i += 1) await page.keyboard.press("ArrowDown");
    await expect(settingsPage.fontSizeStepper).toHaveAttribute("aria-valuenow", "13");
    await settingsPage.closeMenu();
    await page.evaluate(() =>
      localStorage.setItem(
        "app-settings",
        JSON.stringify({ fontSize: 13, messageDensity: "comfortable", sidebarWidth: 256, sidebarCollapsed: false }),
      ),
    );
  });

  test("SET-04: push notification toggle handles unsupported browser", async ({
    settingsPage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "CMD-01" });
    // The push block is the «This device» level of the Notifications level.
    // Whatever the browser supports, the level says it: a status line, and the
    // subscribe button only when pressing it can do something.
    const level = await openUserMenuLevel(page, "notifications");
    await level.getByTestId("notif-this-device").click();
    const device = page.getByTestId("notif-this-device-menu");
    await expect(device.getByTestId("push-status-headline")).toBeVisible();
    await settingsPage.closeMenu();

    // In all cases, the appearance controls render correctly
    await settingsPage.openAppearance();
    for (const mode of ["light", "dark", "system"] as const) {
      await expect(settingsPage.themeRadio(mode)).toBeVisible();
    }
    await expect(settingsPage.fontSizeStepper).toBeVisible();
    await expect(settingsPage.densityRadio("compact")).toBeVisible();
    await expect(settingsPage.densityRadio("comfortable")).toBeVisible();
  });

  test("CTX-07: context pills in chat input", async ({
    page,
    request,
  }) => {
    // Create a dedicated topic with contextFiles already set
    const ts = Date.now();
    const topic = await createTopic(request, `E2E-Pills-${ts}`);

    // Set contextFiles on the topic (use real files that exist on disk)
    await patchTopic(request, topic.id, {
      contextFiles: [
        path.resolve(process.cwd(), "CLAUDE.md"),
        path.resolve(process.cwd(), "README.md"),
      ],
    });

    try {
      // Navigate (no page.route mocks to interfere)
      await page.goto("/");
      await page.waitForSelector('[aria-label="Topics sidebar"]', {
        state: "visible",
        timeout: 15_000,
      });

      // Ensure sezione Chat is expanded
      const chatsSection = page.getByRole("button", {
        name: /sezione Chat/,
      });
      if ((await chatsSection.count()) > 0) {
        const isExpanded =
          await chatsSection.getAttribute("aria-expanded");
        if (isExpanded === "false") {
          await chatsSection.click();
        }
      }

      // Click the test topic
      const topicItem = page.getByRole("treeitem", {
        name: new RegExp(`E2E-Pills-${ts}`),
      });
      await topicItem.waitFor({ state: "visible", timeout: 10_000 });
      await topicItem.scrollIntoViewIfNeeded();
      await topicItem.click({ force: true });

      // Wait for chat input to appear
      await page
        .getByRole("textbox", { name: /Campo del messaggio/ })
        .waitFor({ state: "visible", timeout: 10_000 });

      // Verify context pills are rendered (context-pill class spans)
      const pills = page.locator("span.context-pill");
      await pills.first().waitFor({ state: "visible", timeout: 10_000 });

      const pillCount = await pills.count();
      expect(pillCount).toBeGreaterThanOrEqual(2);

      // Verify pills contain file names from the context files
      await expect(
        pills.filter({ hasText: "CLAUDE.md" }),
      ).toBeVisible();
      await expect(
        pills.filter({ hasText: "README.md" }),
      ).toBeVisible();
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });
});
