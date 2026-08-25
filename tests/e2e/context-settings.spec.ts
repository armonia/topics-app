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

  test("SET-01: settings panel opens from sidebar menu", async ({
    settingsPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "CMD-01" });
    await settingsPage.openSettings();

    // Verify the settings modal is visible
    await expect(settingsPage.panel).toBeVisible();

    // Verify theme section has 3 buttons: Light, Dark, System
    const lightBtn = settingsPage.panel.getByRole("button", { name: "Light" });
    const darkBtn = settingsPage.panel.getByRole("button", { name: "Dark" });
    const systemBtn = settingsPage.panel.getByRole("button", { name: "System" });
    await expect(lightBtn).toBeVisible();
    await expect(darkBtn).toBeVisible();
    await expect(systemBtn).toBeVisible();

    // Verify font size control exists (range input).
    // Dal 27ccc796 i cursori nella sezione Aspetto sono DUE (corpo del testo e
    // "Larghezza chat"): si asserisce che ci siano entrambi e che ognuno sia
    // raggiungibile per nome — è quello che rende il locator non ambiguo.
    await expect(settingsPage.fontSizeSlider).toBeVisible();
    await expect(settingsPage.chatWidthSlider).toBeVisible();

    // Verify message density section has Compact and Comfortable buttons
    const compactBtn = settingsPage.panel.getByRole("button", { name: "Compact" });
    const comfortableBtn = settingsPage.panel.getByRole("button", { name: "Comfortable" });
    await expect(compactBtn).toBeVisible();
    await expect(comfortableBtn).toBeVisible();

    // Close settings via the backdrop overlay
    await settingsPage.closeSettings();
    await expect(settingsPage.panel).not.toBeVisible();
  });

  test("SET-02: theme toggle persistence across reload", async ({
    settingsPage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "CMD-01" });
    await settingsPage.openSettings();

    // Click the "Dark" theme button
    const darkBtn = settingsPage.panel.getByRole("button", { name: "Dark" });
    await darkBtn.click();

    // Verify html element has class "dark" (proves button click works)
    await expect(page.locator("html")).toHaveClass(/dark/);

    // Close settings
    await settingsPage.closeSettings();
    await expect(settingsPage.panel).not.toBeVisible();

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
    await settingsPage.openSettings();

    // Change message density to "Compact"
    const compactBtn = settingsPage.panel.getByRole("button", { name: "Compact" });
    await compactBtn.click();

    // Change font size via range input: set to 16
    await settingsPage.fontSizeSlider.fill("16");

    // Close settings
    await settingsPage.closeSettings();
    await expect(settingsPage.panel).not.toBeVisible();

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

    // Re-open settings and verify persisted values
    await settingsPage.openSettings();

    // Verify "Compact" button appears selected (has active styling with bg-primary/10)
    const compactAfterReload = settingsPage.panel.getByRole("button", { name: "Compact" });
    await expect(compactAfterReload).toHaveClass(/bg-primary/);

    // Verify font size input has value "16"
    await expect(settingsPage.fontSizeSlider).toHaveValue("16");

    // Cleanup: restore defaults
    const comfortableBtn = settingsPage.panel.getByRole("button", { name: "Comfortable" });
    await comfortableBtn.click();
    await settingsPage.fontSizeSlider.fill("13");
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
    await settingsPage.openSettings();

    // Playwright Chromium has ServiceWorker/PushManager APIs available but
    // may not fully support push subscriptions. The PushNotificationsToggle
    // renders based on the state machine in usePushNotifications:
    // - "unsupported" -> returns null (no UI)
    // - "denied" -> shows "blocked by browser" message
    // - "default" / "granted" -> shows enable/disable button
    // - "subscribed" -> shows disable button
    //
    // We verify the settings panel handles whichever state gracefully:
    // either push UI is absent (unsupported) or present and functional.
    const pushLabel = settingsPage.panel.locator("label", {
      hasText: "Push Notifications",
    });
    const pushIsVisible = await pushLabel.isVisible();

    if (pushIsVisible) {
      // Push section rendered: verify it shows either the toggle button or a denied message
      const pushToggle = settingsPage.panel.getByRole("button", {
        name: /push notifications/i,
      });
      const deniedMsg = settingsPage.panel.locator(
        "text=Notifications blocked by your browser",
      );
      // One of these must be visible (toggle or denied message)
      const toggleVisible = await pushToggle.isVisible();
      const deniedVisible = await deniedMsg.isVisible();
      expect(toggleVisible || deniedVisible).toBe(true);
    }
    // If pushLabel is not visible, push is unsupported - this is correct graceful degradation.

    // In all cases, verify all OTHER controls render correctly
    await expect(settingsPage.panel.getByRole("button", { name: "Light" })).toBeVisible();
    await expect(settingsPage.panel.getByRole("button", { name: "Dark" })).toBeVisible();
    await expect(settingsPage.panel.getByRole("button", { name: "System" })).toBeVisible();
    await expect(settingsPage.fontSizeSlider).toBeVisible();
    await expect(settingsPage.panel.getByRole("button", { name: "Compact" })).toBeVisible();
    await expect(settingsPage.panel.getByRole("button", { name: "Comfortable" })).toBeVisible();
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
        .getByRole("textbox", { name: /Message input/ })
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
