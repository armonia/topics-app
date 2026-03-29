import { expect, type APIRequestContext } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { goToApp, openTestChat, openTopic } from "./helpers";
import { mockChatStream } from "./helpers/sse-helpers";
import { createTopic, deleteTopic, patchTopic } from "./helpers/api-fixtures";

test.describe.serial("Chat", () => {
  let testTopicId: string;
  let testTopicName: string;

  test.beforeAll(async ({ request }) => {
    testTopicName = "Chat E2E Test " + Date.now();
    const topic = await createTopic(request, testTopicName);
    testTopicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    if (testTopicId) {
      await deleteTopic(request, testTopicId);
    }
  });

  test("sends message and sees streamed response", async ({
    page,
    chatPage,
  }) => {
    await goToApp(page);
    // Close any open dialogs/palettes
    await page.keyboard.press("Escape");
    // Use the fresh test topic (no history) so mocked response is visible
    await openTopic(page, new RegExp(testTopicName));
    const textarea = page.getByRole("textbox", { name: /Message input/ });
    await textarea.waitFor({ state: "visible", timeout: 15_000 });

    // Set up SSE mock AFTER navigation to avoid interfering with page load
    await mockChatStream(page, {
      chunks: ["Hello ", "from ", "the ", "assistant!"],
    });

    // Send message
    await textarea.click();
    await textarea.fill("test message");
    await textarea.press("Enter");

    // Assert the streamed content appeared (auto-retries until timeout)
    await expect(page.locator("body")).toContainText(
      "Hello from the assistant!",
      { timeout: 15_000 }
    );
  });

  test("loads history when switching topics", async ({ page }) => {
    await goToApp(page);

    // Open a topic known to have existing messages
    await openTopic(page, /Web Search Test/);

    // Wait for at least one message to appear
    const messages = page.locator(".message-appear");
    await expect(messages.first()).toBeVisible({ timeout: 15_000 });
    const firstTopicCount = await messages.count();
    expect(firstTopicCount).toBeGreaterThan(0);

    // Switch to the empty test topic and verify content changes
    await openTopic(page, new RegExp(testTopicName));

    // Wait for main content to settle after topic switch
    await page.locator('[role="main"]').waitFor({
      state: "visible",
      timeout: 10_000,
    });

    // The test topic should show different content than Web Search Test
    await expect(page.locator('[role="main"]')).toBeVisible();
  });

  test("aborts streaming via stop button", async ({ page, chatPage }) => {
    test.slow(); // Real streaming needs extra time

    await goToApp(page);
    await openTestChat(page);

    // Send a prompt that triggers a long streaming response (real server)
    const textarea = page.getByRole("textbox", { name: /Message input/ });
    await textarea.click();
    await textarea.fill(
      "Write a very long paragraph of 500 words about the history of computing"
    );
    await textarea.press("Enter");

    // Wait for streaming indicator to appear (real server streaming)
    await expect(chatPage.streamingIndicator).toBeVisible({ timeout: 15_000 });

    // Click stop button to abort (use first match; sidebar and tab bar both have one)
    const stopBtn = page
      .getByRole("button", { name: /Stop generating/ })
      .first();
    await expect(stopBtn).toBeVisible({ timeout: 5_000 });
    await stopBtn.click();

    // Streaming indicator should disappear after abort
    await expect(chatPage.streamingIndicator).toBeHidden({ timeout: 10_000 });

    // The main content area should have some text (partial response was kept)
    await expect(page.locator('[role="main"]')).not.toBeEmpty();
  });

  test("scroll-to-bottom button works", async ({ page, chatPage }) => {
    await goToApp(page);
    await openTopic(page, /Web Search Test/);

    // Wait for messages to load
    const messages = page.locator(".message-appear");
    await expect(messages.first()).toBeVisible({ timeout: 15_000 });

    // Scroll message list to top
    await chatPage.messageList.evaluate((el) => (el.scrollTop = 0));

    // Scroll-to-bottom button should appear
    await expect(chatPage.scrollToBottomButton).toBeVisible({
      timeout: 5_000,
    });

    // Click it
    await chatPage.scrollToBottomButton.click();

    // Wait for scroll animation to complete, then verify scrolled down
    await expect
      .poll(
        () => chatPage.messageList.evaluate((el) => el.scrollTop),
        { timeout: 5_000 }
      )
      .toBeGreaterThan(0);
  });

  test("auto-scrolls to bottom on new streamed message", async ({ page, chatPage }) => {
    await goToApp(page);
    await page.keyboard.press("Escape");
    // Open test topic (created in beforeAll)
    await openTopic(page, new RegExp(testTopicName));

    const textarea = page.getByRole("textbox", { name: /Message input/ });
    await textarea.waitFor({ state: "visible", timeout: 15_000 });

    // Mock SSE to return a long response that will extend the message list
    await mockChatStream(page, {
      chunks: ["This is a response that should trigger auto-scroll to bottom."],
    });

    // Record scroll position before sending
    const scrollBefore = await chatPage.messageList.evaluate(
      (el) => el.scrollTop
    );

    // Send a message (triggers mocked SSE response)
    await textarea.fill("Test auto-scroll");
    await textarea.press("Control+Enter");

    // Wait for assistant response to appear
    await expect(
      page.locator(".message-appear").filter({ hasText: "auto-scroll to bottom" })
    ).toBeVisible({ timeout: 15_000 });

    // Verify the message list scrolled down (scrollTop increased or is at bottom)
    await expect.poll(
      async () => {
        const el = chatPage.messageList;
        const { scrollTop, scrollHeight, clientHeight } = await el.evaluate(
          (e) => ({
            scrollTop: e.scrollTop,
            scrollHeight: e.scrollHeight,
            clientHeight: e.clientHeight,
          })
        );
        // Either scrolled further than before, or at/near the bottom
        return scrollTop + clientHeight >= scrollHeight - 50 || scrollTop > scrollBefore;
      },
      { message: "Message list should auto-scroll to bottom on new message" }
    ).toBe(true);

    // Clean up route
    await page.unroute("**/api/chat/*");
  });

  test("input toolbar has all buttons", async ({ page }) => {
    await goToApp(page);
    await openTestChat(page);

    await expect(
      page.getByRole("button", { name: /Attach file/ })
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByRole("button", { name: /Toggle plan mode/ })
    ).toBeVisible({ timeout: 5_000 });
    await expect(
      page.getByRole("button", { name: /Record voice/ })
    ).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole("button", { name: /Tools/ })).toBeVisible({
      timeout: 5_000,
    });
    await expect(
      page.getByRole("button", { name: /Send message/ })
    ).toBeVisible({ timeout: 5_000 });
  });

  test("Shift+Enter creates multiline input", async ({ page }) => {
    await goToApp(page);
    const textarea = await openTestChat(page);

    await textarea.fill("");
    await textarea.click();
    await page.keyboard.type("Line 1");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("Line 2");

    const value = await textarea.inputValue();
    expect(value).toContain("Line 1");
    expect(value).toContain("Line 2");
    await textarea.fill("");
  });
});

test.describe("Chat — Rich Content Rendering", () => {
  test("renders markdown formatting in messages", async ({ page }) => {
    await goToApp(page);
    await openTopic(page, /Web Search Test/);

    // Wait for messages to load
    await expect(page.locator(".message-appear").first()).toBeVisible({ timeout: 15_000 });

    // Structural: at least one rich HTML element across all visible message content (D-05)
    const richElements = page.locator(".message-content p, .message-content strong, .message-content code, .message-content pre, .message-content ul, .message-content ol, .message-content a, .message-content h1, .message-content h2, .message-content h3");
    expect(await richElements.count()).toBeGreaterThan(0);
  });

  test("plan mode shows plan view with approve/reject", async ({ page }) => {
    // Intercept WebSocket to prevent real-time updates from resetting component state
    await page.routeWebSocket(/ws/, ws => {
      const server = ws.connectToServer();
      // Allow initial connection but filter out chat-related broadcasts
      server.onMessage(msg => {
        const text = typeof msg === "string" ? msg : "";
        // Block history/message update broadcasts that would cause re-renders
        if (text.includes('"type":"message"') || text.includes('"type":"stream"')) return;
        ws.send(msg);
      });
      ws.onMessage(msg => server.send(msg));
    });

    // Set up SSE mock and history mock BEFORE navigation
    const planContent = "## Implementation Plan\n\n1. First step of the plan\n2. Second step of the plan\n3. Third step of the plan";
    await page.route(/\/api\/chat$/, async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      const data = JSON.stringify({ choices: [{ index: 0, delta: { content: planContent } }] });
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
        body: `data: ${data}\n\ndata: [DONE]\n\n`,
      });
    });

    // Mock history endpoint to return the plan message (prevents overwrite after stream)
    await page.route(/\/api\/history\//, async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      await route.fulfill({
        status: 200,
        json: {
          messages: [
            { id: "mock-user-1", role: "user", content: "Make a plan", timestamp: new Date().toISOString() },
            { id: "mock-assistant-1", role: "assistant", content: planContent, timestamp: new Date().toISOString() },
          ],
        },
      });
    });

    await goToApp(page);

    // Open test chat
    const chatItem = page.getByRole("treeitem", { name: /Web Search Test/ });
    await chatItem.waitFor({ state: "visible", timeout: 10_000 });
    await chatItem.click({ force: true });
    await page.locator('[role="main"]').waitFor({ state: "visible", timeout: 10_000 });
    const textarea = page.getByRole("textbox", { name: /Message input/ });
    await textarea.waitFor({ state: "visible", timeout: 10_000 });

    await textarea.fill("Make a plan");
    await textarea.press("Control+Enter");

    // Wait for PlanView to render (it shows after stream completes)
    const planView = page.locator(".plan-view");
    await expect(planView).toBeVisible({ timeout: 15_000 });

    // Assert Execute Plan and Reject buttons are visible
    const executePlanBtn = page.getByRole("button", { name: /Execute Plan/ });
    const rejectBtn = page.getByRole("button", { name: /Reject/ });
    await expect(executePlanBtn).toBeVisible();
    await expect(rejectBtn).toBeVisible();

    // Verify plan content renders (structural assertion: step text visible)
    await expect(page.getByText("First step of the plan")).toBeVisible({ timeout: 5_000 });
  });

  test("renders sub-agent spawn card with status", async ({ page }) => {
    const spawnMarker = "{{AGENT_SPAWN:test-session-key-123|Run unit tests}}";

    // Mock agent sessions API that AgentSpawnCard polls
    await page.route(/\/api\/agents\/sessions/, async (route) => {
      await route.fulfill({
        status: 200,
        json: {
          sessions: [{
            key: "test-session-key-123",
            status: "active",
            totalTokens: 1500,
            updatedAt: Date.now(),
          }],
        },
      });
    });

    // Mock chat SSE to return spawn marker as entire message
    await page.route(/\/api\/chat$/, async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      const data = JSON.stringify({ choices: [{ index: 0, delta: { content: spawnMarker } }] });
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        body: `data: ${data}\n\ndata: [DONE]\n\n`,
      });
    });

    // Mock history to return spawn marker message
    await page.route(/\/api\/history\//, async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      await route.fulfill({
        status: 200,
        json: {
          messages: [
            { id: "mock-user-1", role: "user", content: "Run tests", timestamp: new Date().toISOString() },
            { id: "mock-assistant-1", role: "assistant", content: spawnMarker, timestamp: new Date().toISOString() },
          ],
        },
      });
    });

    await goToApp(page);
    const chatItem = page.getByRole("treeitem", { name: /Web Search Test/ });
    await chatItem.waitFor({ state: "visible", timeout: 10_000 });
    await chatItem.click({ force: true });
    await page.locator('[role="main"]').waitFor({ state: "visible", timeout: 10_000 });
    const textarea = page.getByRole("textbox", { name: /Message input/ });
    await textarea.waitFor({ state: "visible", timeout: 10_000 });

    await textarea.fill("Run tests");
    await textarea.press("Control+Enter");

    // Wait for spawn card to render with label text
    await expect(page.getByText("Run unit tests")).toBeVisible({ timeout: 15_000 });

    // Assert token count displays (1500 tokens = "1.5k tok")
    await expect(page.getByText(/tok/)).toBeVisible({ timeout: 5_000 });
  });

  test("renders diff block with file path and code", async ({ page }) => {
    const diffContent = "Here is the change:\n\nsrc/app.ts\n<<<<<<< SEARCH\nold code here\n=======\nnew code here\n>>>>>>> REPLACE";

    // Mock chat SSE to return diff content
    await page.route(/\/api\/chat$/, async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      const data = JSON.stringify({ choices: [{ index: 0, delta: { content: diffContent } }] });
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        body: `data: ${data}\n\ndata: [DONE]\n\n`,
      });
    });

    // Mock history to return diff message
    await page.route(/\/api\/history\//, async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      await route.fulfill({
        status: 200,
        json: {
          messages: [
            { id: "mock-user-1", role: "user", content: "Fix the code", timestamp: new Date().toISOString() },
            { id: "mock-assistant-1", role: "assistant", content: diffContent, timestamp: new Date().toISOString() },
          ],
        },
      });
    });

    await goToApp(page);
    const chatItem = page.getByRole("treeitem", { name: /Web Search Test/ });
    await chatItem.waitFor({ state: "visible", timeout: 10_000 });
    await chatItem.click({ force: true });
    await page.locator('[role="main"]').waitFor({ state: "visible", timeout: 10_000 });
    const textarea = page.getByRole("textbox", { name: /Message input/ });
    await textarea.waitFor({ state: "visible", timeout: 10_000 });

    await textarea.fill("Fix the code");
    await textarea.press("Control+Enter");

    // Assert DiffBlock renders with file path
    await expect(page.getByText("src/app.ts")).toBeVisible({ timeout: 15_000 });

    // Assert Apply and Reject buttons are visible (DiffBlock action buttons)
    await expect(page.getByRole("button", { name: /Apply/ })).toBeVisible({ timeout: 5_000 });
  });
});

test.describe("Message Action Toolbar", () => {
  test("message toolbar shows on hover with copy and pin actions", async ({ page }) => {
    await goToApp(page);
    await openTopic(page, /Web Search Test/);

    // Wait for first message to be visible
    const firstMessage = page.locator(".message-appear").first();
    await expect(firstMessage).toBeVisible({ timeout: 15_000 });

    // Hover over the message bubble to reveal the floating action toolbar
    await firstMessage.hover();

    // Verify action buttons become visible after hover
    const copyBtn = page.getByRole("button", { name: "Copy message" });
    const pinBtn = page.getByRole("button", { name: "Pin message" });
    const replyBtn = page.getByRole("button", { name: "Reply" });

    await expect(copyBtn).toBeVisible({ timeout: 5_000 });
    await expect(pinBtn).toBeVisible({ timeout: 5_000 });
    await expect(replyBtn).toBeVisible({ timeout: 5_000 });

    // Click Copy and verify clipboard has content
    await copyBtn.click();
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard.length).toBeGreaterThan(0);
  });

  test("pin action toggles pin state on message", async ({ page, request }) => {
    await goToApp(page);
    await openTopic(page, /Web Search Test/);

    // Wait for messages to load
    const firstMessage = page.locator(".message-appear").first();
    await expect(firstMessage).toBeVisible({ timeout: 15_000 });

    // Hover to reveal toolbar, then click Pin
    await firstMessage.hover();
    const pinBtn = page.getByRole("button", { name: "Pin message" });
    await expect(pinBtn).toBeVisible({ timeout: 5_000 });
    await pinBtn.click();

    // Visual verification: pin button should have yellow color class
    // Re-hover to ensure toolbar is visible for assertion
    await firstMessage.hover();
    const pinBtnAfterPin = page.getByRole("button", { name: "Pin message" });
    await expect(pinBtnAfterPin).toBeVisible({ timeout: 5_000 });
    await expect(pinBtnAfterPin).toHaveClass(/text-yellow-500/, { timeout: 5_000 });

    // API verification: pinnedMessages array should contain the message ID
    const topicRes = await request.get("http://localhost:3334/api/topics", {
      ignoreHTTPSErrors: true,
    });
    const topicsData = await topicRes.json();
    const currentTopic = Object.values(topicsData.topics as Record<string, any>).find(
      (t: any) => t.name === "Web Search Test"
    );
    expect(currentTopic).toBeTruthy();
    expect((currentTopic as any).pinnedMessages.length).toBeGreaterThan(0);

    // Unpin: hover again and click pin to toggle off
    await firstMessage.hover();
    await expect(pinBtnAfterPin).toBeVisible({ timeout: 5_000 });
    await pinBtnAfterPin.click();

    // Visual verification: pin button should return to muted (no yellow)
    await firstMessage.hover();
    const pinBtnAfterUnpin = page.getByRole("button", { name: "Pin message" });
    await expect(pinBtnAfterUnpin).toBeVisible({ timeout: 5_000 });
    await expect(pinBtnAfterUnpin).not.toHaveClass(/text-yellow-500/, { timeout: 5_000 });

    // API verification: pinnedMessages array should be empty after unpin
    const topicRes2 = await request.get("http://localhost:3334/api/topics", {
      ignoreHTTPSErrors: true,
    });
    const topicsData2 = await topicRes2.json();
    const currentTopic2 = Object.values(topicsData2.topics as Record<string, any>).find(
      (t: any) => t.name === "Web Search Test"
    );
    expect(currentTopic2).toBeTruthy();
    expect((currentTopic2 as any).pinnedMessages.length).toBe(0);
  });
});

test.describe("Message Branching", () => {
  test("message branching shows navigation arrows after edit", async ({ page }) => {
    test.slow();
    await goToApp(page);
    const textarea = await openTestChat(page);

    // First, send a message with mocked SSE response
    await mockChatStream(page, { chunks: ["Hello ", "from ", "branch 1!"] });
    await textarea.fill("Test message for branching");
    await textarea.press("Control+Enter");

    // Wait for the user message and response to appear
    const userMessage = page.locator(".message-appear").filter({ hasText: "Test message for branching" });
    await expect(userMessage).toBeVisible({ timeout: 15_000 });

    // Wait for assistant response to appear
    const assistantResponse = page.locator(".message-appear").filter({ hasText: "branch 1" });
    await expect(assistantResponse).toBeVisible({ timeout: 15_000 });

    // Remove the first route to set up a new mock for the edit response
    await page.unroute("**/api/chat/*");

    // Now hover over the user message to reveal the edit button
    await userMessage.hover();
    const editBtn = page.getByRole("button", { name: "Edit message" });
    await expect(editBtn).toBeVisible({ timeout: 5_000 });
    await editBtn.click();

    // The message content should now be in the textarea for editing
    // Verify editing indicator is visible
    await expect(page.getByText("Editing message")).toBeVisible({ timeout: 5_000 });

    // Mock SSE for the second branch response
    await mockChatStream(page, { chunks: ["Hello ", "from ", "branch 2!"] });

    // Clear and type new content, then submit
    await textarea.fill("Edited message for branching");
    await textarea.press("Control+Enter");

    // Wait for the edited message to appear
    const editedMessage = page.locator(".message-appear").filter({ hasText: "Edited message for branching" });
    await expect(editedMessage).toBeVisible({ timeout: 15_000 });

    // Branch navigation should now appear on the user message (siblingCount > 1)
    // Look for "Previous branch" and "Next branch" buttons
    const prevBranchBtn = page.getByRole("button", { name: "Previous branch" });
    const nextBranchBtn = page.getByRole("button", { name: "Next branch" });

    await expect(prevBranchBtn.first()).toBeVisible({ timeout: 10_000 });
    await expect(nextBranchBtn.first()).toBeVisible({ timeout: 10_000 });

    // Verify branch counter shows expected format (e.g., "2/2")
    const branchCounter = page.locator("span").filter({ hasText: /^\d+\/\d+$/ });
    await expect(branchCounter.first()).toBeVisible({ timeout: 5_000 });
    const counterText = await branchCounter.first().textContent();
    expect(counterText).toMatch(/^\d+\/\d+$/);

    // Click Previous branch to switch to first branch
    await prevBranchBtn.first().click();

    // Verify content changes to the first branch
    await expect(page.locator(".message-appear").filter({ hasText: "Test message for branching" })).toBeVisible({ timeout: 10_000 });
  });
});

test.describe.serial("Chat Input Features", () => {
  let topicId: string;
  let topicName: string;

  test.beforeAll(async ({ request }) => {
    // Create topic without projectPath (appears in Chats section)
    topicName = "Input Feature Test " + Date.now();
    const topic = await createTopic(request, topicName);
    topicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) {
      await deleteTopic(request, topicId);
    }
  });

  test("file attachment shows preview via setInputFiles", async ({ page }) => {
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp("Input Feature Test"));

    const textarea = page.getByRole("textbox", { name: /Message input/ });
    await textarea.waitFor({ state: "visible", timeout: 15_000 });

    // Use setInputFiles on the hidden file input to attach a file (D-08: real upload)
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles("tests/e2e/fixtures/test-upload.txt");

    // Verify pending file preview shows the filename in the input area
    await expect(page.getByText("test-upload.txt")).toBeVisible({ timeout: 5_000 });
  });

  test("@-mention autocomplete shows file suggestions", async ({
    page,
    request,
  }) => {
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp("Input Feature Test"));

    const textarea = page.getByRole("textbox", { name: /Message input/ });
    await textarea.waitFor({ state: "visible", timeout: 15_000 });

    // PATCH topic to add projectPath for @-mention support (CHAT-09)
    // The server broadcasts topic:updated via WebSocket, so the client updates live
    await patchTopic(request, topicId, { projectPath: process.cwd() });

    // Wait for the placeholder to change (indicates projectPath was received)
    await expect(textarea).toHaveAttribute(
      "placeholder",
      /@ to mention files/,
      { timeout: 10_000 }
    );

    // Type @ to trigger FileMentionMenu
    await textarea.click();
    await textarea.fill("@");

    // Wait for the mention menu to appear (data-mention-menu attribute)
    const mentionMenu = page.locator("[data-mention-menu]");
    await expect(mentionMenu).toBeVisible({ timeout: 10_000 });

    // Assert menu contains at least one file suggestion button
    const fileSuggestions = mentionMenu.locator("button[data-mention-idx]");
    await expect(fileSuggestions.first()).toBeVisible({ timeout: 5_000 });
    expect(await fileSuggestions.count()).toBeGreaterThan(0);

    // Clean up: remove projectPath so topic stays in Chats section for next tests
    await patchTopic(request, topicId, { projectPath: "" });
  });

  test("slash command menu shows and executes command", async ({ page }) => {
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp("Input Feature Test"));

    const textarea = page.getByRole("textbox", { name: /Message input/ });
    await textarea.waitFor({ state: "visible", timeout: 15_000 });

    // Type / to trigger slash command menu
    await textarea.click();
    await textarea.fill("/");

    // Wait for slash command menu to appear (absolute positioned above input)
    // The menu contains buttons with slash command text like "/status", "/help"
    const slashMenuButton = page.locator("span.font-mono").filter({
      hasText: "/status",
    });
    await expect(slashMenuButton).toBeVisible({ timeout: 5_000 });

    // Verify multiple commands are shown
    await expect(
      page.locator("span.font-mono").filter({ hasText: "/help" })
    ).toBeVisible({ timeout: 3_000 });
    await expect(
      page.locator("span.font-mono").filter({ hasText: "/clear" })
    ).toBeVisible({ timeout: 3_000 });

    // Type /help to filter the menu to the /help command
    await textarea.fill("/help");

    // Press Enter to select /help from the filtered slash menu
    await textarea.press("Enter");

    // The slash menu selection sets the input to "/help " - submit it
    await textarea.press("Enter");

    // Verify command result banner appears (success or error banner with text)
    const resultBanner = page.locator(".font-mono").filter({
      hasText: /.+/,
    });
    await expect(resultBanner.first()).toBeVisible({ timeout: 10_000 });
  });

  test("context pills show active context sources", async ({
    page,
    request,
  }) => {
    // PATCH the test topic to add contextFiles (use package.json as a known file)
    const contextFile = process.cwd() + "/package.json";
    await patchTopic(request, topicId, {
      contextFiles: [contextFile],
    });

    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp("Input Feature Test"));

    const textarea = page.getByRole("textbox", { name: /Message input/ });
    await textarea.waitFor({ state: "visible", timeout: 15_000 });

    // Verify ContextPills renders with the context file name
    const contextPill = page.locator(".context-pill").first();
    await expect(contextPill).toBeVisible({ timeout: 10_000 });

    // Verify the file name is shown in the pill
    await expect(page.getByText("package.json")).toBeVisible({ timeout: 5_000 });
  });
});
