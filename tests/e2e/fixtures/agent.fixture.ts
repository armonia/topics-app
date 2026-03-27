import { test as base, type Page } from "@playwright/test";

export class AgentPage {
  constructor(private page: Page) {}

  get agentList() {
    return this.page.locator('[data-testid="agent-list"]');
  }

  get sessionViewer() {
    return this.page.locator('[data-testid="agent-session-viewer"]');
  }
}

export const test = base.extend<{ agentPage: AgentPage }>({
  agentPage: async ({ page }, use) => {
    await use(new AgentPage(page));
  },
});
