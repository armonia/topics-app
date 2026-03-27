import { test as base, type Page } from "@playwright/test";

export class SidebarPage {
  constructor(private page: Page) {}

  get sidebar() {
    return this.page.locator('[aria-label="Topics sidebar"]');
  }

  get topicList() {
    return this.page.locator('[data-testid="sidebar-topic-list"]');
  }

  get searchInput() {
    return this.page.getByRole("textbox", { name: /Search topics/ });
  }

  get newButton() {
    return this.page.locator('[aria-label="New"]');
  }

  findTopic(name: string | RegExp) {
    return this.page.getByRole("treeitem", { name });
  }

  async createTopic(name: string) {
    await this.newButton.click();
    const nameInput = this.page.getByRole("textbox", { name: /topic name/i });
    await nameInput.fill(name);
    await nameInput.press("Enter");
  }
}

export const test = base.extend<{ sidebarPage: SidebarPage }>({
  sidebarPage: async ({ page }, use) => {
    await use(new SidebarPage(page));
  },
});
