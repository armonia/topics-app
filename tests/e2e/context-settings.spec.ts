import { test, expect } from "./fixtures/test-fixtures";

test.describe("Context, Memory & Settings", () => {
  test.beforeEach(async ({ contextPage, page }) => {
    // Create a dedicated test topic (non-project, standalone chat)
    await contextPage.createTestTopic();

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

  test("CTX-07: context pills in chat input", async ({
    page,
    request,
  }) => {
    // Create a dedicated topic with contextFiles already set
    const { createTopic, patchTopic, deleteTopic } = await import(
      "./helpers/api-fixtures"
    );
    const ts = Date.now();
    const topic = await createTopic(request, `E2E-Pills-${ts}`);

    // Set contextFiles on the topic (use real files that exist on disk)
    await patchTopic(request, topic.id, {
      contextFiles: [
        "/Users/user/.openclaw/workspace/topics-app/CLAUDE.md",
        "/Users/user/.openclaw/workspace/topics-app/README.md",
      ],
    });

    try {
      // Navigate (no page.route mocks to interfere)
      await page.goto("/");
      await page.waitForSelector('[aria-label="Topics sidebar"]', {
        state: "visible",
        timeout: 15_000,
      });

      // Ensure Chats section is expanded
      const chatsSection = page.getByRole("button", {
        name: /Chats section/,
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
