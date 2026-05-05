import { test as base, type Page } from "@playwright/test";

/**
 * Deterministic mock data for browser/process E2E tests.
 */

const MOCK_PACKAGE_SCRIPTS: Record<string, string> = {
  dev: "vite",
  build: "vite build",
  test: "vitest",
  lint: "eslint .",
};

const MOCK_RUNNING_SCRIPTS = [
  {
    processId: "p-1",
    scriptName: "dev",
    command: "vite",
    projectPath: "/mock/project",
    status: "running" as const,
    pid: 12345,
    startedAt: "2026-03-31T10:00:00Z",
    ports: [5173],
  },
];

const MOCK_BROWSER_CONTEXTS = [
  {
    id: "ctx-1",
    url: "https://example.com/page",
    title: "Example Page",
    lastActivity: Date.now() - 60000,
  },
  {
    id: "ctx-2",
    url: "https://docs.test/guide",
    title: "Docs Guide",
    lastActivity: Date.now() - 120000,
  },
];

export class BrowserProcessPage {
  // Phase 30 BROWSER-CHAT-02: promoted to `protected` so BrowserProcessPageV2
  // (extends this class) can call this.page.routeWebSocket / page.route directly
  // for the new WS bridge + tool-agent mocks. Tests in this fixture's own file
  // continue to use `this.page` exactly as before.
  constructor(protected page: Page) {}

  // ── Script Runner Mocks ──

  /**
   * Mock all ScriptRunner API endpoints. Call BEFORE page.goto().
   * Also mocks file-related APIs used by ProjectSidebar to prevent real requests.
   */
  async mockScriptRunner(
    scripts: Record<string, string> = MOCK_PACKAGE_SCRIPTS,
    running: typeof MOCK_RUNNING_SCRIPTS = [],
  ) {
    await this.page.route("**/files/package-scripts*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ scripts }),
      });
    });

    // Mock /scripts endpoint (GET only — list running scripts)
    await this.page.route("**/scripts", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ scripts: running }),
        });
      } else {
        await route.fallback();
      }
    });

    await this.page.route("**/scripts/run", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          processId: "p-new",
          scriptName: "dev",
          pid: 99999,
          startedAt: new Date().toISOString(),
        }),
      });
    });

    await this.page.route("**/scripts/*/stop", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    // Mock file listing for project sidebar (prevents real file system reads)
    await this.page.route("**/api/files*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ files: [] }),
      });
    });

    // Mock git status for project sidebar
    await this.page.route("**/api/git/status*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ files: [], branch: "main", ahead: 0, behind: 0 }),
      });
    });
  }

  // ── Browser Sidebar Mocks ──

  /**
   * Mock BrowserSidebarControl API endpoints. Call BEFORE page.goto().
   */
  async mockBrowserContexts(
    contexts: typeof MOCK_BROWSER_CONTEXTS = MOCK_BROWSER_CONTEXTS,
  ) {
    await this.page.route("**/api/browser/status", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ details: contexts }),
      });
    });

    await this.page.route("**/api/browsers/*", async (route) => {
      if (route.request().method() === "DELETE") {
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

  // ── Remote Browser Panel Mocks ──

  /**
   * Mock RemoteBrowserPanel / useRemoteBrowser API endpoints. Call BEFORE page.goto().
   * This stubs the info, snapshot, and interact endpoints.
   */
  async mockRemoteBrowserPane(opts?: {
    connected?: boolean;
    url?: string;
    title?: string;
    hasScreenshot?: boolean;
  }) {
    const connected = opts?.connected ?? false;
    const url = opts?.url ?? "";
    const title = opts?.title ?? "";

    // GET /api/browsers/:id — info endpoint (match paths with exactly one segment after /browsers/)
    await this.page.route(/\/api\/browsers\/[^/]+$/, async (route) => {
      if (route.request().method() === "GET") {
        if (connected) {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ url, title, connected: true }),
          });
        } else {
          await route.fulfill({ status: 404, body: "Not found" });
        }
      } else if (route.request().method() === "DELETE") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
      } else {
        await route.fallback();
      }
    });

    // POST /api/browsers/:id/interact
    await this.page.route("**/api/browsers/*/interact", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    // GET /api/browsers/:id/snapshot — screenshot endpoint
    await this.page.route("**/api/browsers/*/snapshot*", async (route) => {
      if (opts?.hasScreenshot) {
        // Return a tiny 1x1 PNG
        const png = Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
          "base64",
        );
        await route.fulfill({
          status: 200,
          contentType: "image/png",
          body: png,
        });
      } else {
        await route.fulfill({ status: 404, body: "No screenshot" });
      }
    });
  }

  // ── Navigation Helpers ──

  /**
   * Open a project topic via the Projects section, then expand Processes.
   * Project topics appear in the "Projects" sidebar section, not in Chats treeitems.
   */
  async openProjectAndProcesses(projectNamePattern: RegExp) {
    // Expand Projects section if collapsed
    const projectsSection = this.page.getByRole("button", { name: /Projects section/ });
    if (await projectsSection.count() > 0) {
      const expanded = await projectsSection.getAttribute("aria-expanded");
      if (expanded === "false") {
        await projectsSection.click();
      }
    }

    // Click the project folder button in the sidebar
    const projectBtn = this.page
      .locator('[aria-label="Topics sidebar"] button')
      .filter({ hasText: projectNamePattern })
      .first();
    await projectBtn.waitFor({ state: "visible", timeout: 10000 });
    await projectBtn.click();

    // Wait for project pane to appear (the ProjectSidebar with Processes section)
    await this.page.locator('[role="main"]').waitFor({ state: "visible", timeout: 10000 });

    // Click "Processes" section header to expand it
    const processesBtn = this.page.locator('button:has-text("Processes")').first();
    await processesBtn.waitFor({ state: "visible", timeout: 10000 });
    await processesBtn.click();

    // Wait for script-runner to appear
    await this.page.locator('[data-testid="script-runner"]').waitFor({ state: "visible", timeout: 10000 });
  }

  /**
   * Expand the Browser sidebar section.
   */
  async expandBrowserSection() {
    const browserBtn = this.page.getByRole("button", { name: "Browser section" });
    await browserBtn.waitFor({ state: "visible", timeout: 10000 });
    const isExpanded = await browserBtn.getAttribute("aria-expanded");
    if (isExpanded !== "true") {
      await browserBtn.click();
    }
    // Wait for browser sidebar content to render (BrowserSidebarControl root div.pb-2)
    await this.page.locator('.pb-2 .px-2').first().waitFor({ state: "visible", timeout: 10000 });
  }

  /**
   * Open a browser pane via the Settings & Tools dropdown menu.
   */
  async openBrowserPaneViaMenu() {
    const settingsBtn = this.page.locator('button[title="Settings & Tools"]');
    await settingsBtn.click();
    const browserItem = this.page.locator('button:has-text("Browser"):visible');
    await browserItem.click();
  }

  // ── Locators ──

  get scriptRunner() {
    return this.page.locator('[data-testid="script-runner"]');
  }

  get browserSectionButton() {
    return this.page.getByRole("button", { name: "Browser section" });
  }

  get urlInput() {
    return this.page.locator('input[placeholder="Enter URL..."]');
  }
}

// Export mock data for direct use in tests
export { MOCK_PACKAGE_SCRIPTS, MOCK_RUNNING_SCRIPTS, MOCK_BROWSER_CONTEXTS };

export const test = base.extend<{ browserProcessPage: BrowserProcessPage }>({
  browserProcessPage: async ({ page }, use) => {
    await use(new BrowserProcessPage(page));
  },
});
