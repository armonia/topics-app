import { test as base, type Page } from "@playwright/test";
import { goToApp } from "../helpers";

export class KanbanPage {
  constructor(private page: Page) {}

  get board() {
    return this.page.locator('[data-testid="kanban-board"]');
  }

  getColumn(status: string) {
    return this.page.locator(`[data-testid="kanban-column-${status}"]`);
  }

  getTaskCard(text: string | RegExp) {
    return this.page.locator('[data-testid="kanban-board"]').getByText(text);
  }

  get detailPanel() {
    return this.page.locator('[data-testid="task-detail-panel"]');
  }

  get settingsPanel() {
    return this.page.locator('[data-testid="board-settings-panel"]');
  }

  get approvalModal() {
    return this.page.locator('[data-testid="approval-review-modal"]');
  }

  get memoryPanel() {
    return this.page.locator('[data-testid="board-memory-panel"]');
  }

  get allBoardsPane() {
    return this.page.locator('[data-testid="all-boards-pane"]');
  }

  get filterBar() {
    return this.page.locator('[data-testid="kanban-board"]').locator('select').first();
  }

  getTaskDragHandle(text: string | RegExp) {
    // Find the task card container that contains the text, then locate the drag handle.
    // Task cards are: div[data-testid^="task-card-"] > button[data-testid="task-card-drag-handle"]
    // Use :has() to find the card div that contains the matching text, then get its drag handle.
    return this.board
      .locator('[data-testid^="task-card-"]', { hasText: text })
      .locator('[data-testid="task-card-drag-handle"]');
  }

  /** Navigate to the all-boards pane via sidebar button */
  async gotoAllBoards() {
    await goToApp(this.page);
    // The "Board" button with task count is at the top of the sidebar
    const boardBtn = this.page.locator('button[title="View all project boards"]');
    if (await boardBtn.isVisible().catch(() => false)) {
      await boardBtn.click();
    } else {
      // Fallback: look for the Board link/button in sidebar header area
      const boardLink = this.page.getByRole('button', { name: /^Board/ });
      await boardLink.click();
    }
    await this.allBoardsPane.waitFor({ state: 'visible', timeout: 10000 });
  }

  /**
   * Navigate to a project-specific board by:
   * 1. Opening the app and expanding the Projects section
   * 2. Clicking the project's child topic to open a chat pane (creates a group)
   * 3. Clicking "Open full Board" in the project sidebar's TaskBoard section
   * 4. Clicking the Board tab in the inner tab bar to switch to the board view
   * 5. Waiting for the KanbanBoard component (data-testid="kanban-board")
   */
  async gotoProjectBoard(projectPath: string, topicName?: string | RegExp) {
    await goToApp(this.page);

    // Expand the Projects section if collapsed
    const projectsSection = this.page.getByRole("button", { name: /Projects section/ });
    if (await projectsSection.count() > 0) {
      const expanded = await projectsSection.getAttribute("aria-expanded");
      if (expanded === "false") {
        await projectsSection.click();
      }
    }

    // Find the project header and expand it to reveal child topics
    const projectHeader = this.page.locator(`button[title="${projectPath}"]`);
    await projectHeader.waitFor({ state: "visible", timeout: 10000 });

    // Click the project header to expand and open the project pane
    await projectHeader.click();

    // If a topic name was provided, find and click it to create a chat pane
    // (the project window needs at least one pane/group to add a board pane)
    if (topicName) {
      const topicItem = this.page.getByRole('treeitem', { name: topicName });
      await topicItem.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
      if (await topicItem.isVisible()) {
        await topicItem.click();
        // Wait for the chat pane to appear (creates a group in the project window)
        await this.page.locator('[data-testid="panel-tab-bar"]').last()
          .waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
      }
    }

    // Wait for the "Open full Board" button in the project sidebar
    const openBoardBtn = this.page.locator('button[title="Open full Board"]');
    await openBoardBtn.waitFor({ state: "visible", timeout: 10000 });

    // Click "Open full Board" -- adds a board pane to the group
    await openBoardBtn.click();

    // The board pane is added as a tab. Try waiting for it directly.
    try {
      await this.board.waitFor({ state: "visible", timeout: 5000 });
      return;
    } catch {
      // Board not the active tab? Find and click the "Board" tab.
    }

    // Look for the Board tab in inner tab bars and click it
    const boardTab = this.page.locator('[data-testid="panel-tab-bar"]').last()
      .getByText('Board', { exact: true });
    if (await boardTab.isVisible().catch(() => false)) {
      await boardTab.click();
    }

    await this.board.waitFor({ state: "visible", timeout: 10000 });
  }
}

export const test = base.extend<{ kanbanPage: KanbanPage }>({
  kanbanPage: async ({ page }, use) => {
    await use(new KanbanPage(page));
  },
});
