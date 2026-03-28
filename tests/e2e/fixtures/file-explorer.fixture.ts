import { test as base, type Page } from "@playwright/test";
import { goToApp } from "../helpers";

export class FileExplorerPage {
  constructor(private page: Page) {}

  // --- Navigation ---

  /**
   * Navigate to a project's file explorer by:
   * 1. Opening the app and expanding the Projects section
   * 2. Clicking the project header to open the project pane
   * 3. Optionally clicking a child topic to create a pane group
   * 4. Waiting for the file tree to become visible
   */
  async gotoProject(projectPath: string, topicName?: string | RegExp) {
    await goToApp(this.page);

    // Expand the Projects section if collapsed
    const projectsSection = this.page.getByRole("button", {
      name: /Projects section/,
    });
    if ((await projectsSection.count()) > 0) {
      const expanded = await projectsSection.getAttribute("aria-expanded");
      if (expanded === "false") {
        await projectsSection.click();
      }
    }

    // Find the project header and click to open
    const projectHeader = this.page.locator(
      `button[title="${projectPath}"]`
    );
    await projectHeader.waitFor({ state: "visible", timeout: 10000 });
    await projectHeader.click();

    // If a topic name was provided, click it to create a chat pane (ensures a group exists)
    if (topicName) {
      const topicItem = this.page.getByRole("treeitem", { name: topicName });
      await topicItem
        .waitFor({ state: "visible", timeout: 5000 })
        .catch(() => {});
      if (await topicItem.isVisible()) {
        await topicItem.click();
        await this.page
          .locator('[data-testid="panel-tab-bar"]')
          .last()
          .waitFor({ state: "visible", timeout: 5000 })
          .catch(() => {});
      }
    }

    // Wait for file tree to appear
    await this.fileTree.waitFor({ state: "visible", timeout: 15000 });
  }

  // --- File Tree ---

  get fileTree() {
    return this.page.locator('[data-testid="file-tree"]');
  }

  getTreeItem(name: string) {
    return this.fileTree.getByRole("treeitem", { name });
  }

  getDirNode(name: string | RegExp) {
    return this.fileTree.locator('[role="treeitem"]', { hasText: name });
  }

  // --- Editor & Tabs ---

  get editorTabs() {
    return this.page.locator('[data-testid="editor-tabs"]');
  }

  getTab(name: string) {
    return this.editorTabs.locator("div", { hasText: name }).first();
  }

  // --- Breadcrumb ---

  get breadcrumb() {
    return this.page.locator('[data-testid="breadcrumb-nav"]');
  }

  getBreadcrumbSegment(name: string) {
    return this.breadcrumb.getByRole("button", { name });
  }

  // --- Git ---

  get gitChanges() {
    return this.page.locator('[data-testid="git-changes"]');
  }

  getGitStatusLabel(filename: string) {
    const treeItem = this.fileTree.locator('[role="treeitem"]', {
      hasText: filename,
    });
    return treeItem.locator("span").last(); // git status badge is last span
  }

  // --- File Search ---

  get fileSearch() {
    return this.page.locator('[data-testid="file-search"]');
  }

  async openFileSearch() {
    await this.page.keyboard.press("Meta+Shift+f");
  }

  // --- Diff Viewer ---

  get diffViewer() {
    return this.page.locator('[data-testid="diff-viewer"]');
  }

  // --- Script Runner ---

  get scriptRunner() {
    return this.page.locator('[data-testid="script-runner"]');
  }

  getScript(name: string) {
    return this.scriptRunner.locator("div", { hasText: name });
  }

  // --- Process List ---

  get processList() {
    return this.page.locator('[data-testid="process-list"]');
  }

  // --- Sidebar Section Expansion ---

  async expandSection(name: string) {
    // Click section header button with matching text (e.g., "Files", "Git Changes", "Scripts")
    const header = this.page.locator("button", { hasText: name });
    const expanded = await header.getAttribute("aria-expanded");
    if (expanded === "false") {
      await header.click();
    }
  }
}

export const test = base.extend<{ fileExplorerPage: FileExplorerPage }>({
  fileExplorerPage: async ({ page }, use) => {
    await use(new FileExplorerPage(page));
  },
});
