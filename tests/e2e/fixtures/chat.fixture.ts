import { test as base, type Page } from "@playwright/test";

export class ChatPage {
  constructor(private page: Page) {}

  get messageInput() {
    // BOTH LANGUAGES, because the label follows the chosen one.
    // The composer's aria-label used to be a hardcoded Italian string, so a
    // single Italian pattern matched it whatever the interface said. Since the
    // chat went through the i18n catalogue (`chat.composer.inputAria`) an
    // English interface answers "Message input for <name>", and a spec that
    // switches the language to English (surfaces-i18n) stopped finding its own
    // composer. The alternation is the honest locator: one composer, two names.
    return this.page.getByRole("textbox", { name: /Campo del messaggio|Message input for/ });
  }

  get messageList() {
    // react-virtuoso (4.18.1) does NOT forward the data-testid prop passed to
    // <Virtuoso>, so [data-testid="chat-message-list"] never exists. The real
    // scrolling element is Virtuoso's internal scroller, tagged with the
    // [data-virtuoso-scroller] attribute (same one chat.spec's scroll-to-bottom
    // test targets). It only exists once the list is non-empty (Virtuoso mounts).
    return this.page.locator("[data-virtuoso-scroller]").first();
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
