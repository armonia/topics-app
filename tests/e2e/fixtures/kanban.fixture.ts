import { test as base, type Page } from "@playwright/test";

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
    // Find the task card containing the text, then locate its drag handle
    return this.getTaskCard(text).locator('..').locator('[data-testid="task-card-drag-handle"]');
  }

  /** Navigate to the all-boards pane via sidebar button */
  async gotoAllBoards() {
    await this.page.locator('button[title="View all project boards"]').click();
    await this.allBoardsPane.waitFor({ state: 'visible', timeout: 10000 });
  }
}

export const test = base.extend<{ kanbanPage: KanbanPage }>({
  kanbanPage: async ({ page }, use) => {
    await use(new KanbanPage(page));
  },
});
