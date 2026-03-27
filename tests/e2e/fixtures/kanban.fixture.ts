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
}

export const test = base.extend<{ kanbanPage: KanbanPage }>({
  kanbanPage: async ({ page }, use) => {
    await use(new KanbanPage(page));
  },
});
