import { expect } from "@playwright/test";
import { test, MOCK_RUNNING_SCRIPTS, MOCK_BROWSER_CONTEXTS } from "./fixtures/browser.fixture";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic } from "./helpers/api-fixtures";

// ── ScriptRunner Tests ──

test.describe("ScriptRunner", () => {
  // Use a unique root path so the project gets its own sidebar button
  const PROJECT_PATH = `/Users/e2e-script-runner-${Date.now()}`;
  const PROJECT_NAME_PATTERN = /e2e-script-runner/;
  let topicId: string;

  test.beforeAll(async ({ request }) => {
    const topic = await createTopic(request, "E2E-ScriptRunner", {
      projectPath: PROJECT_PATH,
    });
    topicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId).catch(() => {});
  });

  test("PROCESS-01: Script list renders from package.json", async ({
    page,
    browserProcessPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "PROCESS-01" });

    await browserProcessPage.mockScriptRunner();
    await goToApp(page);
    await browserProcessPage.openProjectAndProcesses(PROJECT_NAME_PATTERN);

    const runner = browserProcessPage.scriptRunner;
    await expect(runner).toBeVisible();

    // All 4 scripts should be listed (exact match to avoid matching command text)
    await expect(runner.getByText("dev", { exact: true })).toBeVisible();
    await expect(runner.getByText("build", { exact: true })).toBeVisible();
    await expect(runner.getByText("test", { exact: true })).toBeVisible();
    await expect(runner.getByText("lint", { exact: true })).toBeVisible();
  });

  test("PROCESS-02: Running script shows green indicator and stop button", async ({
    page,
    browserProcessPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "PROCESS-01" });

    // Set projectPath in running scripts to match our test project
    const running = MOCK_RUNNING_SCRIPTS.map((s) => ({ ...s, projectPath: PROJECT_PATH }));
    await browserProcessPage.mockScriptRunner(
      { dev: "vite", build: "vite build", test: "vitest", lint: "eslint ." },
      running,
    );
    await goToApp(page);
    await browserProcessPage.openProjectAndProcesses(PROJECT_NAME_PATTERN);

    const runner = browserProcessPage.scriptRunner;

    // Running script "dev" should have green text
    const devRow = runner.locator("div.flex.items-center").filter({ hasText: "dev" }).first();
    await expect(devRow).toBeVisible();
    const devName = devRow.locator("span.text-green-500");
    await expect(devName).toBeVisible();

    // Stop button should be visible (title="Stop")
    const stopBtn = devRow.locator('button[title="Stop"]');
    await expect(stopBtn).toBeVisible();
  });

  test("PROCESS-03: Run a script sends POST /scripts/run", async ({
    page,
    browserProcessPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "PROCESS-01" });

    await browserProcessPage.mockScriptRunner();
    await goToApp(page);
    await browserProcessPage.openProjectAndProcesses(PROJECT_NAME_PATTERN);

    const runner = browserProcessPage.scriptRunner;

    // Listen for the run request
    const runPromise = page.waitForRequest(
      (req) => req.url().includes("/scripts/run") && req.method() === "POST",
    );

    // Click on idle "build" script to run it
    const buildRow = runner.locator("div.flex.items-center").filter({ hasText: "build" }).first();
    await buildRow.click();

    const runReq = await runPromise;
    const body = runReq.postDataJSON();
    expect(body.scriptName).toBe("build");
  });

  test("PROCESS-04: Stop a running script sends POST to stop endpoint", async ({
    page,
    browserProcessPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "PROCESS-01" });

    const running = MOCK_RUNNING_SCRIPTS.map((s) => ({ ...s, projectPath: PROJECT_PATH }));
    await browserProcessPage.mockScriptRunner(
      { dev: "vite", build: "vite build", test: "vitest", lint: "eslint ." },
      running,
    );
    await goToApp(page);
    await browserProcessPage.openProjectAndProcesses(PROJECT_NAME_PATTERN);

    const runner = browserProcessPage.scriptRunner;

    // Listen for stop request
    const stopPromise = page.waitForRequest(
      (req) => req.url().includes("/stop") && req.method() === "POST",
    );

    // Click the Stop button on running "dev" script
    const devRow = runner.locator("div.flex.items-center").filter({ hasText: "dev" }).first();
    const stopBtn = devRow.locator('button[title="Stop"]');
    await stopBtn.click();

    const stopReq = await stopPromise;
    expect(stopReq.url()).toContain("p-1");
  });

  test("PROCESS-05: Running script shows port link", async ({
    page,
    browserProcessPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "PROCESS-01" });

    const running = MOCK_RUNNING_SCRIPTS.map((s) => ({ ...s, projectPath: PROJECT_PATH }));
    await browserProcessPage.mockScriptRunner(
      { dev: "vite", build: "vite build", test: "vitest", lint: "eslint ." },
      running,
    );
    await goToApp(page);
    await browserProcessPage.openProjectAndProcesses(PROJECT_NAME_PATTERN);

    const runner = browserProcessPage.scriptRunner;

    // Port link ":5173" should be visible
    const portLink = runner.locator("a").filter({ hasText: ":5173" });
    await expect(portLink).toBeVisible();
    const href = await portLink.getAttribute("href");
    expect(href).toContain("5173");
  });
});

// ── BrowserSidebarControl Tests ──

test.describe("BrowserSidebarControl", () => {
  test("BROWSER-01: Context list renders with titles", async ({
    page,
    browserProcessPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "BROWSER-01" });

    await browserProcessPage.mockBrowserContexts(MOCK_BROWSER_CONTEXTS);
    await goToApp(page);
    await browserProcessPage.expandBrowserSection();

    // Both context titles should appear
    await expect(page.getByText("Example Page")).toBeVisible();
    await expect(page.getByText("Docs Guide")).toBeVisible();
  });

  test("BROWSER-02: Close browser context sends DELETE", async ({
    page,
    browserProcessPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "BROWSER-01" });

    await browserProcessPage.mockBrowserContexts(MOCK_BROWSER_CONTEXTS);
    await goToApp(page);
    await browserProcessPage.expandBrowserSection();

    // Listen for DELETE request
    const deletePromise = page.waitForRequest(
      (req) => req.url().includes("/api/browsers/") && req.method() === "DELETE",
    );

    // Hover context item to reveal close button and click X
    const contextItem = page.getByText("Example Page");
    await contextItem.hover();
    // The X close button is inside the same parent div as the text
    const closeBtn = contextItem.locator("..").locator("button");
    await closeBtn.click();

    const deleteReq = await deletePromise;
    expect(deleteReq.url()).toContain("ctx-1");
  });

  test("BROWSER-03: Empty state shows message", async ({
    page,
    browserProcessPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "BROWSER-01" });

    await browserProcessPage.mockBrowserContexts([]);
    await goToApp(page);
    await browserProcessPage.expandBrowserSection();

    await expect(page.getByText("No active browser contexts")).toBeVisible();
  });
});

// ── RemoteBrowserPanel Tests ──

test.describe("RemoteBrowserPanel", () => {
  test("BROWSER-04: Toolbar renders navigation controls", async ({
    page,
    browserProcessPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "BROWSER-02" });

    await browserProcessPage.mockBrowserContexts(MOCK_BROWSER_CONTEXTS);
    await browserProcessPage.mockRemoteBrowserPane();
    await goToApp(page);
    await browserProcessPage.expandBrowserSection();

    // Click first browser context to open a browser pane
    await page.getByText("Example Page").click();

    // Wait for toolbar buttons to appear
    await expect(page.locator('button[title="Back"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('button[title="Forward"]')).toBeVisible();
    await expect(page.locator('button[title="Refresh"]')).toBeVisible();
    await expect(page.locator('button[title="Home"]')).toBeVisible();
  });

  test("BROWSER-05: URL bar accepts input and navigates", async ({
    page,
    browserProcessPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "BROWSER-02" });

    await browserProcessPage.mockBrowserContexts(MOCK_BROWSER_CONTEXTS);
    await browserProcessPage.mockRemoteBrowserPane();
    await goToApp(page);
    await browserProcessPage.expandBrowserSection();

    // Open browser pane
    await page.getByText("Example Page").click();

    const urlInput = page.locator('input[placeholder="Enter URL..."]');
    await expect(urlInput).toBeVisible({ timeout: 10000 });

    // Listen for navigation interact request
    const navPromise = page.waitForRequest(
      (req) => req.url().includes("/interact") && req.method() === "POST",
    );

    await urlInput.click();
    await urlInput.fill("https://test.example.com");
    await urlInput.press("Enter");

    const navReq = await navPromise;
    const body = navReq.postDataJSON();
    expect(body.action).toBe("navigate");
    expect(body.url).toBe("https://test.example.com");
  });

  test("BROWSER-06: No session state shows disconnect message", async ({
    page,
    browserProcessPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "BROWSER-02" });

    await browserProcessPage.mockBrowserContexts(MOCK_BROWSER_CONTEXTS);
    await browserProcessPage.mockRemoteBrowserPane({ connected: false });
    await goToApp(page);
    await browserProcessPage.expandBrowserSection();

    // Open browser pane
    await page.getByText("Example Page").click();

    // Disconnected state text
    await expect(page.getByText("No browser session")).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("Enter a URL above to start")).toBeVisible();
  });

  test("BROWSER-07: Browser ready state with no URL", async ({
    page,
    browserProcessPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "BROWSER-02" });

    await browserProcessPage.mockBrowserContexts(MOCK_BROWSER_CONTEXTS);
    await browserProcessPage.mockRemoteBrowserPane({ connected: true, url: "" });
    await goToApp(page);
    await browserProcessPage.expandBrowserSection();

    // Open browser pane
    await page.getByText("Example Page").click();

    await expect(page.getByText("Browser ready")).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("Enter a URL above to navigate")).toBeVisible();
  });

  test("BROWSER-08: Screenshot renders when available", async ({
    page,
    browserProcessPage,
  }) => {
    test.info().annotations.push({ type: "spec", description: "BROWSER-02" });

    await browserProcessPage.mockBrowserContexts(MOCK_BROWSER_CONTEXTS);
    await browserProcessPage.mockRemoteBrowserPane({
      connected: true,
      url: "https://example.com",
      title: "Example",
      hasScreenshot: true,
    });
    await goToApp(page);
    await browserProcessPage.expandBrowserSection();

    // Open browser pane
    await page.getByText("Example Page").click();

    // Screenshot image should appear with alt text
    const img = page.locator('img[alt="Example"]').or(page.locator('img[alt="Browser page"]'));
    await expect(img).toBeVisible({ timeout: 15000 });
  });
});
