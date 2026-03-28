import { test as base, type Page } from "@playwright/test";

/**
 * Deterministic mock data for context inspector E2E tests.
 * All values are fixed for reproducible assertions.
 */
export const MOCK_CONTEXT_ANALYSIS = {
  sources: [
    {
      id: "openclaw:SOUL.md",
      label: "SOUL.md",
      category: "openclaw",
      tokens: 3200,
      enabled: true,
      editable: false,
      preview: "Soul document content for the assistant personality...",
      countInBudget: true,
    },
    {
      id: "memory:topic",
      label: "Topic Memory",
      category: "memory",
      tokens: 420,
      enabled: true,
      editable: true,
      preview: "Working on E2E tests for context inspector...",
      countInBudget: true,
    },
    {
      id: "memory:global",
      label: "Global Memory",
      category: "memory",
      tokens: 850,
      enabled: true,
      editable: true,
      preview: "User prefers TypeScript and functional patterns...",
      countInBudget: true,
    },
    {
      id: "prompt:system",
      label: "System Prompt",
      category: "prompt",
      tokens: 180,
      enabled: true,
      editable: true,
      preview: "You are a helpful coding assistant...",
      countInBudget: true,
    },
  ],
  totalTokens: 4650,
  budgetLimit: 200000,
  budgetPercent: 2,
  warnings: [],
};

export const MOCK_HIGH_BUDGET_ANALYSIS = {
  sources: [
    {
      id: "openclaw:SOUL.md",
      label: "SOUL.md",
      category: "openclaw",
      tokens: 45000,
      enabled: true,
      editable: false,
      preview: "Soul document content...",
      countInBudget: true,
    },
    {
      id: "memory:topic",
      label: "Topic Memory",
      category: "memory",
      tokens: 50000,
      enabled: true,
      editable: true,
      preview: "Large topic memory...",
      countInBudget: true,
    },
    {
      id: "memory:global",
      label: "Global Memory",
      category: "memory",
      tokens: 55000,
      enabled: true,
      editable: true,
      preview: "Large global memory...",
      countInBudget: true,
    },
    {
      id: "prompt:system",
      label: "System Prompt",
      category: "prompt",
      tokens: 20000,
      enabled: true,
      editable: true,
      preview: "You are a helpful assistant...",
      countInBudget: true,
    },
  ],
  totalTokens: 170000,
  budgetLimit: 200000,
  budgetPercent: 85,
  warnings: [
    {
      type: "budget",
      detail:
        "Context usage is at 85% of budget (170000 / 200000 tokens)",
    },
    {
      type: "large-source",
      detail: "SOUL.md uses 45000 tokens",
    },
  ],
};

export const MOCK_MEMORY_DATA = {
  topicContent: "Topic-specific notes here",
  globalContent: "Global notes here",
  topicId: "test-topic-id",
  maxTopicBytes: 10240,
  maxGlobalBytes: 51200,
};

export class ContextPage {
  constructor(private page: Page) {}

  // --- Navigation ---

  /**
   * Open context inspector: click first topic in sidebar, wait for chat,
   * then click the Context Inspector button (Layers icon).
   */
  async openContextInspector() {
    // Click first topic in sidebar
    const treeItems = this.page.getByRole("treeitem");
    const count = await treeItems.count();
    for (let i = 0; i < Math.min(count, 20); i++) {
      const item = treeItems.nth(i);
      const text = await item.textContent();
      if (
        !text ||
        text.length < 2 ||
        /^(Projects|Chats|Terminals|Browser|Archived)/i.test(text.trim())
      )
        continue;
      await item.click();
      break;
    }

    // Wait for chat textarea to confirm topic opened
    await this.page
      .getByRole("textbox", { name: /Message input/ })
      .waitFor({ state: "visible", timeout: 10_000 });

    // Click Context Inspector button
    await this.page
      .locator('button[title="Context Inspector"]')
      .click();

    // Wait for inspector panel to be visible
    await this.inspector.waitFor({ state: "visible", timeout: 10_000 });
  }

  // --- Mock Helpers ---

  /**
   * Mock the /api/context/analyze endpoint with deterministic data.
   * Must be called BEFORE page.goto().
   */
  async mockContextAnalyze(data = MOCK_CONTEXT_ANALYSIS) {
    await this.page.route("**/api/context/analyze*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(data),
      });
    });
  }

  /**
   * Mock with high-budget analysis (85%) and warnings.
   * Must be called BEFORE page.goto().
   */
  async mockContextAnalyzeHighBudget() {
    await this.mockContextAnalyze(MOCK_HIGH_BUDGET_ANALYSIS);
  }

  /**
   * Mock all memory endpoints: GET/PUT/DELETE /api/memory routes.
   * Must be called BEFORE page.goto().
   */
  async mockMemoryEndpoints() {
    // GET /api/memory/:topicId
    await this.page.route("**/api/memory/*", async (route) => {
      const method = route.request().method();
      const url = route.request().url();

      if (method === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(MOCK_MEMORY_DATA),
        });
      } else if (method === "PUT") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
      } else if (method === "DELETE") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
      } else {
        await route.fallback();
      }
    });

    // PUT /api/memory (global - no trailing path segment)
    await this.page.route(/\/api\/memory$/, async (route) => {
      const method = route.request().method();
      if (method === "PUT") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
      } else {
        await route.fallback();
      }
    });
  }

  // --- Locator Getters ---

  get inspector() {
    return this.page.locator('[data-testid="context-inspector"]');
  }

  get budgetBar() {
    return this.page.locator('[data-testid="context-budget-bar"]');
  }

  get budgetPercent() {
    return this.page.locator('[data-testid="budget-percent"]');
  }

  get warnings() {
    return this.page.locator('[data-testid="context-warnings"]');
  }

  get sourceRows() {
    return this.page.locator('[data-testid="context-source-row"]');
  }

  get contextPills() {
    return this.page.locator('[data-testid="context-pills"]');
  }

  get contextPill() {
    return this.page.locator('[data-testid="context-pill"]');
  }
}

export const test = base.extend<{ contextPage: ContextPage }>({
  contextPage: async ({ page }, use) => {
    await use(new ContextPage(page));
  },
});
