import { test as base, type Page } from "@playwright/test";

export class ChatPage {
  constructor(private page: Page) {}

  get messageInput() {
    return this.page.getByRole("textbox", { name: /Message input/ });
  }

  get messageList() {
    return this.page.locator('[data-testid="chat-message-list"]');
  }

  get streamingIndicator() {
    return this.page.locator('[data-testid="chat-streaming-indicator"]');
  }

  get scrollToBottomButton() {
    return this.page.getByRole("button", { name: /Scroll to bottom/ });
  }

  async sendMessage(text: string) {
    await this.messageInput.fill(text);
    await this.messageInput.press("Control+Enter");
  }

  async waitForResponse() {
    await this.streamingIndicator
      .waitFor({ state: "visible", timeout: 10_000 })
      .catch(() => {});
    await this.streamingIndicator
      .waitFor({ state: "hidden", timeout: 60_000 })
      .catch(() => {});
  }
}

export const test = base.extend<{ chatPage: ChatPage }>({
  chatPage: async ({ page }, use) => {
    await use(new ChatPage(page));
  },
});
