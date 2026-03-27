import { test as base, type Page } from "@playwright/test";

export class FileExplorerPage {
  constructor(private page: Page) {}

  get fileTree() {
    return this.page.locator('[data-testid="file-explorer-tree"]');
  }

  get editor() {
    return this.page.locator('[data-testid="file-explorer-editor"]');
  }

  get breadcrumb() {
    return this.page.locator('[data-testid="file-explorer-breadcrumb"]');
  }

  async openFile(path: string) {
    await this.fileTree.getByText(path).click();
  }
}

export const test = base.extend<{ fileExplorerPage: FileExplorerPage }>({
  fileExplorerPage: async ({ page }, use) => {
    await use(new FileExplorerPage(page));
  },
});
