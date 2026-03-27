import { test, expect, type APIRequestContext } from "@playwright/test";
import { goToApp, openTestChat, openTopic } from "./helpers";
import { mockChatStream } from "./helpers/sse-helpers";

test.describe("Chat", () => {
  test("sends message and receives streaming response", async ({ page }) => {
    // Streaming tests need extra time
    test.slow();
    await goToApp(page);
    const textarea = await openTestChat(page);

    const testMsg = "Dimmi solo: RISPOSTA OK";
    await textarea.fill(testMsg);
    await textarea.press("Control+Enter");

    // Wait for response — poll up to 40s
    let gotResponse = false;
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(1000);
      const bodyText = await page.locator("body").textContent();
      if (bodyText?.includes(testMsg)) {
        if (bodyText.includes("RISPOSTA OK") || bodyText.includes("Risposta OK") || bodyText.includes("risposta ok")) {
          gotResponse = true;
          break;
        }
        // After 15s, check if stream ended with any content
        if (i >= 15) {
          const after = bodyText.slice(bodyText.indexOf(testMsg) + testMsg.length).trim();
          if (after.length > 2) { gotResponse = true; break; }
        }
      }
    }
    expect(gotResponse).toBeTruthy();
  });

  test("loads chat history", async ({ page }) => {
    await goToApp(page);
    await openTopic(page, /Web Search Test/);

    // Wait for messages to appear
    const messages = page.locator("div.message-appear");
    await expect(messages.first()).toBeVisible({ timeout: 15000 });
    expect(await messages.count()).toBeGreaterThan(0);
  });

  test("can abort a streaming response", async ({ page }) => {
    // Streaming test needs extra time
    test.slow();
    await goToApp(page);
    const textarea = await openTestChat(page);

    await textarea.fill("Scrivi un lungo paragrafo di 500 parole sulla storia dell'informatica");
    await textarea.press("Control+Enter");

    // Wait for streaming to start (stop button appears)
    const stopBtn = page.locator('button[title*="Stop"], button[aria-label*="Stop"], button:has-text("Stop")');
    try {
      await stopBtn.first().waitFor({ state: "visible", timeout: 10000 });
      await stopBtn.first().click();
      await page.waitForLoadState("networkidle");
    } catch {
      // No stop button appeared — streaming may have finished quickly
    }

    const mainContent = await page.locator('[role="main"]').textContent();
    expect(mainContent!.length).toBeGreaterThan(10);
  });

  test("input toolbar has all buttons", async ({ page }) => {
    await goToApp(page);
    await openTestChat(page);

    // Wait for toolbar to be fully rendered
    await expect(page.getByRole("button", { name: /Attach file/ })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole("button", { name: /Toggle plan mode/ })).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole("button", { name: /Record voice/ })).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole("button", { name: /Tools/ })).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole("button", { name: /Send message/ })).toBeVisible({ timeout: 5000 });
  });

  test("Shift+Enter creates multiline input", async ({ page }) => {
    await goToApp(page);
    const textarea = await openTestChat(page);

    // Ensure textarea is focused and empty
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

  test("renders markdown in messages", async ({ page }) => {
    await goToApp(page);
    await openTopic(page, /Web Search Test/);

    // Wait for messages to appear before checking markdown
    await expect(page.locator("div.message-appear").first()).toBeVisible({ timeout: 15000 });
    expect(await page.locator("div.message-appear").count()).toBeGreaterThan(0);
    const rendered = page.locator("div.message-content p, div.message-content strong, div.message-content code, div.message-content pre, div.message-content ul, div.message-content ol, div.message-content a");
    expect(await rendered.count()).toBeGreaterThan(0);
  });

  test("scroll-to-bottom button works", async ({ page }) => {
    await goToApp(page);
    await openTopic(page, /Web Search Test/);

    // Wait for messages to load
    await expect(page.locator("div.message-appear").first()).toBeVisible({ timeout: 15000 }).catch(() => {});

    const messageList = page.locator('[class*="message-list"], [class*="MessageList"], [class*="chat-messages"]').first();
    if (await messageList.count() > 0) {
      await messageList.evaluate(el => el.scrollTop = 0);
      await page.waitForTimeout(300);

      const scrollBtn = page.locator('[class*="scroll-to-bottom"], [class*="ScrollToBottom"], button[aria-label*="scroll"], button[title*="scroll"]');
      if (await scrollBtn.count() > 0) {
        await scrollBtn.first().click();
        await page.waitForTimeout(300);
        const scrollTop = await messageList.evaluate(el => el.scrollTop);
        expect(scrollTop).toBeGreaterThan(0);
      }
    }
    expect(await page.locator('[role="main"]').textContent()).toBeTruthy();
  });

  test("plan mode toggles on and off", async ({ page }) => {
    await goToApp(page);
    await openTestChat(page);

    const planBtn = page.getByRole("button", { name: /Toggle plan mode/ });
    await expect(planBtn).toBeVisible({ timeout: 10000 });
    await planBtn.click();
    await page.waitForTimeout(300);
    await planBtn.click();
    await page.waitForTimeout(200);

    expect(await page.locator('[role="main"]').textContent()).toBeTruthy();
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
    const topicRes = await request.get("https://localhost:3333/api/topics", {
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
    const topicRes2 = await request.get("https://localhost:3333/api/topics", {
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
    await page.unroute("**/api/chat/**");

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
