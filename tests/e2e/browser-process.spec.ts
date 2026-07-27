import { expect } from "@playwright/test";
import { test, MOCK_RUNNING_SCRIPTS, MOCK_BROWSER_CONTEXTS } from "./fixtures/browser.fixture";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, seedPaneStore, waitForTopicVisible } from "./helpers/api-fixtures";

// ── Phase 27 -> Phase 30 disposition map (per plan 30-05 Task 6, I11 strategy) ──
//
// PROCESS-01..05  PASS         ScriptRunner unchanged by phase 30
// BROWSER-01      REMOVED      Replaced by BROWSER-CHAT-04 (browser-tab-open.spec.ts).
//                              The legacy "sezione Browser" sidebar control was
//                              retired in phase 30-04 in favor of the per-topic
//                              browser pane (mounted via /browser slash command
//                              or browser:open-and-navigate CustomEvent).
// BROWSER-02      REMOVED      DELETE /api/browsers/:id is now exercised by
//                              browser-persistence.spec.ts (BROWSER-CHAT-01).
// BROWSER-03      REMOVED      Empty-state UX now lives in the Topic-level pane
//                              flow; covered by BROWSER-CHAT-04 indirectly.
// BROWSER-04..08  REWRITTEN    Mount RemoteBrowserPanel via the new
//                              browser:open-and-navigate CustomEvent flow (the
//                              "sezione Browser" sidebar control is gone).
//                              Behavior contracts (toolbar, URL bar, ready
//                              state, screenshot rendering) preserved.

// Helper: mount a RemoteBrowserPanel for the given topic via the canonical
// CustomEvent path. Resolves once the connection indicator OR the localhost
// iframe is visible. Mirrors the helper used in browser-tab-open.spec.ts.
async function mountBrowserPaneViaEvent(
  page: import("@playwright/test").Page,
  topicId: string,
  url = "https://example.com",
): Promise<void> {
  await page.evaluate(
    ({ tid, u }) => {
      window.dispatchEvent(
        new CustomEvent("browser:open-and-navigate", {
          detail: { topicId: tid, url: u },
        }),
      );
    },
    { tid: topicId, u: url },
  );
  // Gate on the toolbar URL input (present in both stream + iframe render paths).
  // The connection-indicator pill hides in the steady 'connected' state now.
  await expect(page.locator('[data-testid="browser-url-input"]').first()).toBeVisible({ timeout: 10000 });
}

// ── ScriptRunner Tests (PROCESS-01..05: PASS, unchanged from phase 27) ──

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

  // PROCESS-01: PASS — ScriptRunner unchanged by phase 30.
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

  // PROCESS-02: PASS — ScriptRunner unchanged by phase 30.
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

  // PROCESS-03: PASS — ScriptRunner unchanged by phase 30.
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

  // PROCESS-04: PASS — ScriptRunner unchanged by phase 30.
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

  // PROCESS-05: PASS — ScriptRunner unchanged by phase 30.
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

// ── BrowserSidebarControl Tests (BROWSER-01..03: REMOVED in plan 30-05) ──
//
// REMOVED in plan 30-05: the legacy "sezione Browser" sidebar control was
// retired in phase 30-04. Per-topic browser panes are now created via the
// /browser slash command (BROWSER-CHAT-04) and the per-topic
// browser:open-and-navigate CustomEvent flow. Coverage moved to:
//   - tests/e2e/browser-tab-open.spec.ts (BROWSER-CHAT-04)
//   - tests/e2e/browser-persistence.spec.ts (DELETE /api/browsers/:id)
//
// The describe block below preserves the test names as REMOVED markers so
// `grep "BROWSER-0[123]:"` still finds documented dispositions.
test.describe("BrowserSidebarControl (REMOVED in plan 30-05)", () => {
  // BROWSER-01: REMOVED — context list rendered by retired sidebar; coverage
  // moved to browser-tab-open.spec.ts (BROWSER-CHAT-04).
  test.skip("BROWSER-01: Context list renders with titles (REMOVED in plan 30-05)", async () => {});

  // BROWSER-02: REMOVED — DELETE /api/browsers/:id covered by
  // browser-persistence.spec.ts (BROWSER-CHAT-01 calls DELETE to flush
  // storage.json before assertion).
  test.skip("BROWSER-02: Close browser context sends DELETE (REMOVED in plan 30-05)", async () => {});

  // BROWSER-03: REMOVED — empty-state UX no longer applies; sidebar control is
  // gone. The new Topic-level browser pane handles its own ready/disconnect
  // states (BROWSER-04..07 below).
  test.skip("BROWSER-03: Empty state shows message (REMOVED in plan 30-05)", async () => {});
});

// ── RemoteBrowserPanel Tests (BROWSER-04..08: REWRITTEN — mount via CustomEvent) ──
//
// REWRITTEN in plan 30-05: phase 27 mounted RemoteBrowserPanel by clicking
// a context entry in the Browser sidebar section. That section was retired
// in phase 30-04. The panel itself is unchanged in shape (toolbar, URL bar,
// screenshot rendering, ready/disconnected states); we now mount via the
// canonical browser:open-and-navigate CustomEvent (same code path
// /browser slash command uses).

test.describe("RemoteBrowserPanel", () => {
  // Reset pane-store-v2 BEFORE each test so the e2e-script-runner project
  // pane (created in the ScriptRunner describe's beforeAll) doesn't own the
  // layout — usePaneOrdering's browser:open-and-navigate listener bails out
  // early when hasProjectPaneRef.current is true.
  // `lastSeq` comes from seedPaneStore: hard-coding it (this used to send 0)
  // loses the client's LWW gate against any state the serial run accumulated,
  // so the reset looked written but never applied.
  test.beforeEach(async ({ request }) => {
    await seedPaneStore(request, () => ({
      panes: {},
      groups: {
        "group:default": {
          id: "group:default",
          paneIds: [],
          splitRatio: 1,
          splitAxis: "horizontal",
        },
      },
      projects: {},
      groupOrder: ["group:default"],
      closedStack: [],
    }));
  });

  // BROWSER-04: REWRITTEN — mount via CustomEvent (was: click sidebar context).
  test("BROWSER-04: Toolbar renders navigation controls", async ({
    page,
    browserProcessPage,
    request,
  }) => {
    test.info().annotations.push({ type: "spec", description: "BROWSER-02" });

    await browserProcessPage.mockBrowserContexts(MOCK_BROWSER_CONTEXTS);
    await browserProcessPage.mockRemoteBrowserPane();
    const topic = await createTopic(request, `E2E-Toolbar-${Date.now()}`);
    try {
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      await mountBrowserPaneViaEvent(page, topic.id);

      // Wait for toolbar buttons to appear. The toolbar is localized (IT): Back
      // → "Indietro", Forward → "Avanti" (both carry a variable suffix when the
      // nav-history menu is available, hence title^=). Refresh keeps its English
      // title. The old "Home" button was replaced by the conditional
      // back-to-spawner control; assert the always-present URL input instead.
      await expect(page.locator('button[title^="Indietro"]')).toBeVisible({ timeout: 10000 });
      await expect(page.locator('button[title^="Avanti"]')).toBeVisible();
      await expect(page.locator('button[title="Refresh"]')).toBeVisible();
      await expect(page.locator('[data-testid="browser-url-input"]')).toBeVisible();
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });

  // BROWSER-05: REWRITTEN — mount via CustomEvent. With the WS-first hook
  // attempting /ws/browser/:id first, the URL navigate is forwarded over WS
  // when the connection succeeds. We add a no-op routeWebSocket mock so the
  // WS attempt fails immediately and the hook falls back to REST /interact
  // (the path this test asserts against).
  test("BROWSER-05: URL bar accepts input and navigates", async ({
    page,
    browserProcessPage,
    request,
  }) => {
    test.info().annotations.push({ type: "spec", description: "BROWSER-02" });

    // FIXED-WS-mock: short-circuit the WS attempt (no-op accept + close)
    // so useRemoteBrowser falls back to REST /interact without the 2s
    // FALLBACK_DELAY_MS tax. Plan 30-05 I11 strategy.
    await page.routeWebSocket(/\/ws\/browser\//, (ws) => {
      setTimeout(() => { try { ws.close(); } catch { /* ignore */ } }, 0);
    });

    await browserProcessPage.mockBrowserContexts(MOCK_BROWSER_CONTEXTS);
    await browserProcessPage.mockRemoteBrowserPane();
    const topic = await createTopic(request, `E2E-UrlBar-${Date.now()}`);
    try {
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      await mountBrowserPaneViaEvent(page, topic.id);

      const urlInput = page.locator('[data-testid="browser-url-input"]');
      await expect(urlInput).toBeVisible({ timeout: 10000 });

      // Listen for navigation interact request (REST fallback path).
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
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });

  // BROWSER-06: REMOVED in plan 30-05.
  //
  // Phase 27 asserted the "No browser session" placeholder when REST
  // returned 404. In phase 30 the `connected` flag is derived from
  // `connectionState` (true for both 'connected' and 'fallback-http'),
  // so the placeholder is no longer reachable via REST 404 alone — the
  // panel renders "Browser ready" or "Starting browser..." instead until
  // both WS AND REST fail repeatedly. The disconnected-state coverage
  // moved to:
  //   - tests/e2e/browser-ws-streaming.spec.ts (test 5: connection
  //     indicator transitions live -> fallback -> disconnected)
  // Original test was: assert "No browser session" message when REST 404.
  test.skip("BROWSER-06: No session state shows disconnect message (REMOVED in plan 30-05)", async () => {});

  // BROWSER-07: REWRITTEN — ready state asserted on connected-but-no-URL flow.
  test("BROWSER-07: Browser ready state with no URL", async ({
    page,
    browserProcessPage,
    request,
  }) => {
    test.info().annotations.push({ type: "spec", description: "BROWSER-02" });

    // Force WS to drop so connectionState transitions to fallback-http where
    // REST /api/browsers/:id reports connected=true with empty url.
    await page.routeWebSocket(/\/ws\/browser\//, (ws) => {
      setTimeout(() => { try { ws.close(); } catch { /* ignore */ } }, 0);
    });

    await browserProcessPageMockReady(browserProcessPage);

    const topic = await createTopic(request, `E2E-Ready-${Date.now()}`);
    try {
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      // Mount with about:blank — the panel's "Browser ready" placeholder
      // renders when connected && (!url || url === 'about:blank').
      await mountBrowserPaneViaEvent(page, topic.id, "about:blank");

      await expect(page.getByText("Browser ready")).toBeVisible({ timeout: 10000 });
      await expect(page.getByText("Enter a URL above to navigate")).toBeVisible();
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });

  // BROWSER-08: the WebRTC migration removed the JPEG <img> render entirely
  // ("zero JPEG shown"): the pane's surface is the H.264 <video> (or the native
  // <iframe>), never a screenshot image — not even in the WS-down fallback. This
  // asserts the modern contract: with the transport unavailable (WS closed), the
  // pane still MOUNTS and surfaces the shared-session negotiation state, and NO
  // dead JPEG <img> is rendered.
  test("BROWSER-08: no JPEG <img> surface — pane mounts + shows the shared-session state", async ({
    page,
    browserProcessPage,
    request,
  }) => {
    test.info().annotations.push({ type: "spec", description: "BROWSER-02" });

    // Close the browser WS immediately → no WebRTC signaling can complete.
    await page.routeWebSocket(/\/ws\/browser\//, (ws) => {
      setTimeout(() => { try { ws.close(); } catch { /* ignore */ } }, 0);
    });

    await browserProcessPage.mockBrowserContexts(MOCK_BROWSER_CONTEXTS);
    await browserProcessPage.mockRemoteBrowserPane({
      connected: true,
      url: "https://example.com",
      title: "Example",
      hasScreenshot: true,
    });

    const topic = await createTopic(request, `E2E-Screenshot-${Date.now()}`);
    try {
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      await mountBrowserPaneViaEvent(page, topic.id, "https://example.com");

      // The pane mounted (toolbar URL input present) and surfaces the shared-
      // session negotiation state, not a JPEG screenshot.
      await expect(page.locator('[data-testid="browser-url-input"]').first()).toBeVisible({ timeout: 15000 });
      await expect(page.getByText(/Avvio sessione condivisa/)).toBeVisible({ timeout: 15000 });
      // The removed JPEG <img> surface must never render.
      await expect(page.locator('img[alt="Example"], img[alt="Browser page"]')).toHaveCount(0);
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });
});

/**
 * Helper for BROWSER-07: REST returns connected=true with empty URL so the
 * RemoteBrowserPanel renders its "Browser ready / Enter a URL above" state.
 */
async function browserProcessPageMockReady(
  fixture: import("./fixtures/browser.fixture").BrowserProcessPage,
): Promise<void> {
  await fixture.mockBrowserContexts(MOCK_BROWSER_CONTEXTS);
  await fixture.mockRemoteBrowserPane({ connected: true, url: "" });
}
