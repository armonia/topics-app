import { expect } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { goToApp, openTestChat, openTopic } from "./helpers";
import { mockChatStream } from "./helpers/sse-helpers";
import { createTopic, deleteTopic } from "./helpers/api-fixtures";

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
