import { test as base, type Page, type APIRequestContext } from "@playwright/test";
import { createTopic, deleteTopic } from "../helpers/api-fixtures";

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
  private _topicId: string | null = null;
  private _topicName: string | null = null;

  constructor(
    private page: Page,
    private request: APIRequestContext,
  ) {}

  /**
   * Create a dedicated test topic for context tests.
   * Call in test.beforeEach so cleanup can delete it.
   */
  async createTestTopic() {
    const ts = Date.now();
    this._topicName = `E2E-CTX-${ts}`;
    const topic = await createTopic(this.request, this._topicName);
    this._topicId = topic.id;
    return topic;
  }

  /** Clean up the test topic */
  async cleanup() {
    if (this._topicId) {
      await deleteTopic(this.request, this._topicId).catch(() => {});
    }
  }

  get topicId() {
    return this._topicId;
  }

  // --- Navigation ---

  /**
   * Open context inspector: click the test topic in sidebar, then
   * open the context inspector by clicking the ring or button.
   */
  async openContextInspector() {
    // Ensure sezione Chat is expanded
    const chatsSection = this.page.getByRole("button", {
      name: /sezione Chat/,
    });
    if ((await chatsSection.count()) > 0) {
      const isExpanded = await chatsSection.getAttribute("aria-expanded");
      if (isExpanded === "false") {
        await chatsSection.click();
      }
    }

    // Click the test topic by name
    const topicItem = this.page.getByRole("treeitem", {
      name: new RegExp(this._topicName!),
    });
    await topicItem.waitFor({ state: "visible", timeout: 10_000 });
    await topicItem.scrollIntoViewIfNeeded();
    await topicItem.click({ force: true });

    // Wait for chat textarea to confirm topic opened
    await this.page
      .getByRole("textbox", { name: /Message input/ })
      .waitFor({ state: "visible", timeout: 10_000 });

    // Open the Context Inspector. The trigger depends on layout:
    //  1. Split/project panes render a per-pane header with a "Context
    //     Inspector" (Layers) button (only when `!headerLeft`).
    //  2. The single-window layout hides that header button; the trigger
    //     lives in the ChatInput action bar as the context-budget ring
    //     (`[data-testid="chat-input-context-ring"]`). The ring SVG itself
    //     carries `cursor-pointer` ONLY when handed an onClick — here the
    //     wrapping button owns the click, so `svg.cursor-pointer` matches
    //     nothing. Target the button's stable testid instead.
    const directBtn = this.page.locator(
      'button[title="Ispettore del contesto"]',
    );
    const inputRing = this.page
      .locator('[data-testid="chat-input-context-ring"]')
      .first();
    if (
      (await directBtn.count()) > 0 &&
      (await directBtn.first().isVisible())
    ) {
      await directBtn.first().click();
    } else {
      await inputRing.waitFor({ state: "visible", timeout: 10_000 });
      await inputRing.click();
    }

    // Wait for inspector panel to be visible (use first() since
    // the container and inner panel may both match the selector)
    await this.inspector
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });
  }

  // --- Mock Helpers ---

  /**
   * Mock the /api/context/analyze endpoint with deterministic data.
   * Must be called BEFORE page.goto().
   */
  async mockContextAnalyze(
    data: typeof MOCK_CONTEXT_ANALYSIS | typeof MOCK_HIGH_BUDGET_ANALYSIS = MOCK_CONTEXT_ANALYSIS,
  ) {
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
  // Use data-testid when available (worktree build), fall back to
  // content/structural selectors for the production build.

  /** The inspector panel root. Il testid e' il contratto: il titolo e' passato
   *  da "Context Inspector" a "Contesto"/"Context" e vive nell'i18n. */
  get inspector() {
    return this.page
      .locator('[data-testid="context-inspector"]')
      .or(
        this.page.locator(
          '.flex.flex-col.h-full.bg-surface.border-l:has([data-testid="context-budget-bar"])',
        ),
      );
  }

  /** Budget bar: il blocco in cima col grafico. */
  get budgetBar() {
    return this.page.locator('[data-testid="context-budget-bar"]');
  }

  /** Percentage text */
  get budgetPercent() {
    return this.page.locator('[data-testid="budget-percent"]');
  }

  /** Warnings section: contains "warning" text */
  get warnings() {
    return this.page
      .locator('[data-testid="context-warnings"]')
      .or(
        this.inspector.locator("div.border-b").filter({ hasText: /warning/i }),
      );
  }

  /** Source rows: border-b divs with "tok" text (token count display) */
  get sourceRows() {
    return this.page
      .locator('[data-testid="context-source-row"]')
      .or(
        this.inspector
          .locator("div.border-b")
          .filter({ hasText: /tok$/ }),
      );
  }

  /** Context pills container */
  get contextPills() {
    return this.page
      .locator('[data-testid="context-pills"]')
      .or(this.page.locator("div:has(> span.context-pill)"));
  }

  /** Individual context pill */
  get contextPill() {
    return this.page
      .locator('[data-testid="context-pill"]')
      .or(this.page.locator("span.context-pill"));
  }
}

export const test = base.extend<{ contextPage: ContextPage }>({
  contextPage: async ({ page, request }, use) => {
    const cp = new ContextPage(page, request);
    await use(cp);
    await cp.cleanup();
  },
});
