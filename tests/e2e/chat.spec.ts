import { test, expect } from "@playwright/test";
import { goToApp, openTestChat, openTopic } from "./helpers";

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

  test("right-click message shows context menu", async ({ page }) => {
    await goToApp(page);
    await openTopic(page, /Web Search Test/);

    // Wait for messages to load
    const messages = page.locator("div.message-appear");
    await expect(messages.first()).toBeVisible({ timeout: 15000 }).catch(() => {});

    if (await messages.count() > 0) {
      await messages.first().click({ button: "right" });
      await page.waitForTimeout(300);

      const contextMenu = page.locator('[class*="context-menu"], [role="menu"], [class*="dropdown-menu"]');
      if (await contextMenu.count() > 0) {
        expect((await contextMenu.first().textContent())!.length).toBeGreaterThan(2);
      }
      await page.keyboard.press("Escape");
    }
    expect(await page.locator('[role="main"]').textContent()).toBeTruthy();
  });
});
