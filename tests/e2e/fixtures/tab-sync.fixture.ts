import { test as base, expect, type Page } from "@playwright/test";

const BASE = "http://localhost:13334";

export class TabSyncPage {
  constructor(private page: Page) {}

  /** Get all visible tab labels from the first tab bar */
  async getTabLabels(): Promise<string[]> {
    const tabBar = this.page.locator('[data-testid="panel-tab-bar"]').first();
    await expect(tabBar).toBeVisible({ timeout: 10000 });
    const tabs = tabBar.locator('[draggable="true"]');
    const count = await tabs.count();
    const labels: string[] = [];
    for (let i = 0; i < count; i++) {
      const text = await tabs.nth(i).textContent();
      if (text) labels.push(text.trim());
    }
    return labels;
  }

  /** Wait for a PUT request to /api/ui-state to complete (debounced sync) */
  async waitForSyncPut(keyPattern?: string | RegExp): Promise<void> {
    await this.page.waitForResponse(
      (resp) => {
        if (resp.request().method() !== "PUT") return false;
        if (!resp.url().includes("/api/ui-state")) return false;
        if (keyPattern) {
          const url = resp.url();
          if (typeof keyPattern === "string") return url.includes(keyPattern);
          return keyPattern.test(url);
        }
        return true;
      },
      { timeout: 10000 }
    );
  }

  /** Clear all ui-state entries via API (reset for clean test state) */
  async clearUiState(): Promise<void> {
    await this.page.request.put(`${BASE}/api/ui-state/panels`, {
      data: { openPanels: [] },
    }).catch(() => {});
    await this.page.request.put(`${BASE}/api/ui-state/panel-order`, {
      data: { order: [], pinned: [] },
    }).catch(() => {});
  }

  /** Open a pane type via the add-pane (+) menu */
  async openPaneByType(typeName: string | RegExp): Promise<void> {
    const addPaneBtn = this.page.getByTitle("Add pane");
    await expect(addPaneBtn.first()).toBeVisible({ timeout: 5000 });
    await addPaneBtn.first().click();

    const addMenu = this.page.locator(".fixed.z-\\[9999\\]");
    await expect(addMenu).toBeVisible({ timeout: 5000 });

    const menuButtons = addMenu.locator("button");
    const count = await menuButtons.count();
    for (let i = 0; i < count; i++) {
      const text = ((await menuButtons.nth(i).textContent()) || "").trim();
      const match =
        typeof typeName === "string"
          ? text.toLowerCase().includes(typeName.toLowerCase())
          : typeName.test(text);
      if (match) {
        await menuButtons.nth(i).click();
        return;
      }
    }
    // Fallback: click first option
    await menuButtons.first().click();
  }

  /** Get draggable tab locators from first tab bar */
  get tabs() {
    return this.page
      .locator('[data-testid="panel-tab-bar"]')
      .first()
      .locator('[draggable="true"]');
  }

  /** Check if a tab has italic (preview) styling */
  async isPreviewTab(tabIndex: number): Promise<boolean> {
    const tab = this.tabs.nth(tabIndex);
    const span = tab.locator("span.italic");
    return (await span.count()) > 0;
  }
}

export const test = base.extend<{ tabSyncPage: TabSyncPage }>({
  tabSyncPage: async ({ page }, use) => {
    await use(new TabSyncPage(page));
  },
});
