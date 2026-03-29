import { test as base, expect, type Page } from "@playwright/test";

export class LayoutPage {
  constructor(private page: Page) {}

  get tabBar() {
    return this.page.locator('[data-testid="panel-tab-bar"]');
  }

  get connectionStatus() {
    return this.page.locator('[data-testid="connection-status"]');
  }

  get mainContent() {
    return this.page.locator('[role="main"]');
  }

  get sidebar() {
    return this.page.locator('[aria-label="Topics sidebar"]');
  }

  get sidebarToggleButton() {
    return this.page.getByTitle("Toggle sidebar");
  }

  async toggleSidebar() {
    await this.page.keyboard.press("Meta+b");
  }

  /** Open a project by clicking its sidebar button, wait for tab bar */
  async openProject(name: string | RegExp) {
    const projectBtn =
      typeof name === "string"
        ? this.page.locator(`button:has-text("${name}")`)
        : this.page.locator("button").filter({ hasText: name });
    await projectBtn.first().click();
    await expect(
      this.page.locator('[data-testid="panel-tab-bar"]').first()
    ).toBeVisible({ timeout: 10000 });
  }

  /** Open any available chat topic, wait for message input */
  async openAnyTopic() {
    const treeItems = this.page.getByRole("treeitem");
    const count = await treeItems.count();
    for (let i = 0; i < Math.min(count, 30); i++) {
      const item = treeItems.nth(i);
      const text = await item.textContent();
      if (!text || text.length < 2) continue;
      if (/^(Projects|Chats|Terminals|Browser|Archived)/i.test(text.trim()))
        continue;
      await item.click();
      // Wait for message input to appear (confirms a chat opened)
      const textarea = this.page.getByRole("textbox", {
        name: /Message input/,
      });
      const visible = await textarea
        .waitFor({ state: "visible", timeout: 5000 })
        .then(() => true)
        .catch(() => false);
      if (visible) return;
    }
  }

  /** Right-click the nth draggable tab in the first tab bar */
  async rightClickTab(tabIndex = 0) {
    const tab = this.tabBar
      .first()
      .locator('[draggable="true"]')
      .nth(tabIndex);
    await tab.click({ button: "right" });
  }

  /** Get context menu item texts after a right-click (portaled to body) */
  async getContextMenuItems(): Promise<string[]> {
    const menu = this.page.locator(".fixed.z-\\[9999\\]");
    await expect(menu).toBeVisible({ timeout: 5000 });
    const buttons = menu.locator("button");
    const count = await buttons.count();
    const items: string[] = [];
    for (let i = 0; i < count; i++) {
      const text = await buttons.nth(i).textContent();
      if (text) items.push(text.trim());
    }
    return items;
  }
}

export const test = base.extend<{ layoutPage: LayoutPage }>({
  layoutPage: async ({ page }, use) => {
    await use(new LayoutPage(page));
  },
});
