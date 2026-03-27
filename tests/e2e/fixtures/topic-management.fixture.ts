import { test as base, type Page, type Locator } from "@playwright/test";
import { goToApp, openTopic } from "../helpers";

export class TopicManagementPage {
  constructor(private page: Page) {}

  /** Navigate to the app and wait for sidebar */
  async goto() {
    await goToApp(this.page);
  }

  /** Open a topic by name */
  async openTopic(name: string | RegExp) {
    await openTopic(this.page, name);
  }

  /** Get the sidebar locator */
  get sidebar() {
    return this.page.locator('[aria-label="Topics sidebar"]');
  }

  /** Find a topic treeitem by name */
  findTopic(name: string | RegExp) {
    return this.page.getByRole("treeitem", { name });
  }

  /** Get the search input */
  get searchInput() {
    return this.page.getByRole("searchbox", { name: /Search topics/ });
  }

  /** Get the main content panel */
  get mainPanel() {
    return this.page.locator('[role="main"]');
  }

  /** Right-click a topic to open context menu */
  async openContextMenu(topicName: string | RegExp) {
    await this.findTopic(topicName).click({ button: "right" });
    const menu = this.page.getByRole("menu");
    await menu.waitFor({ state: "visible" });
    return menu;
  }

  /** Click a menu item in the context menu */
  async clickMenuItem(menu: Locator, name: string | RegExp) {
    await menu.getByRole("menuitem", { name }).click();
  }

  /** Get the new topic dialog */
  get newTopicDialog() {
    return this.page.getByRole("dialog");
  }

  /** Open the new topic modal via the Chats section "New chat" button */
  async openNewTopicModal() {
    // Hover on the Chats section header to reveal the "+" button
    const chatsHeader = this.page.getByRole("button", {
      name: /Chats section/,
    });
    await chatsHeader.hover();
    // Click the "New chat" button that appears on hover
    const newChatBtn = this.page.getByRole("button", { name: /New chat/i });
    await newChatBtn.first().click();
  }

  /** Create a topic through the "New" button in the top bar (opens modal with templates) */
  async openNewTopicModalViaTopBar() {
    await this.page.locator('[aria-label="New"]').click();
  }
}

export const test = base.extend<{ topicPage: TopicManagementPage }>({
  topicPage: async ({ page }, use) => {
    await use(new TopicManagementPage(page));
  },
});

export { expect } from "@playwright/test";
