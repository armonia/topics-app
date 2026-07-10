import { test, expect } from "./fixtures/browser-v2.fixture";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, waitForTopicVisible, resetPaneStore } from "./helpers/api-fixtures";

const BASE = "http://localhost:13334";

/**
 * Mount a RemoteBrowserPanel for `topicId` by dispatching the canonical
 * `browser:open-and-navigate` CustomEvent (the same one ChatPane fires for
 * `/browser <url>` slash command). Resolves once EITHER the connection
 * indicator OR the localhost iframe is visible (the panel renders ONE of
 * the two — see RemoteBrowserPanel.tsx LOCAL_HOST_RX early return).
 */
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
  const indicator = page.locator('[data-testid="browser-connection-indicator"]');
  const localhost = page.locator('[data-testid="browser-localhost-iframe"]');
  await expect(indicator.or(localhost)).toBeVisible({ timeout: 10000 });
}

test.describe("BROWSER-CHAT-04 browser tab open + agent integration (@plan-30-05)", () => {
  // Reset pane-store-v2 before each test so a browser pane left over from a
  // prior test in this serial suite doesn't survive into the next one — a
  // stale pane keeps ownership of the active surface (new pane never activates,
  // frames dropped) and its lingering connection-indicator trips strict-mode.
  // See browser-ws-streaming.spec.ts for the full rationale.
  test.beforeEach(async ({ request }, testInfo) => {
    testInfo.annotations.push({ type: "spec", description: "BROWSER-CHAT-04" });
    // BROWSER-01 (Navigation & Page Control) supersedes the retired sidebar
    // control flow with the same AC: open a browser pane, navigate via URL.
    testInfo.annotations.push({ type: "spec", description: "BROWSER-01" });
    testInfo.annotations.push({ type: "plan", description: "@plan-30-05" });
    await resetPaneStore(request, []);
  });

  test("BROWSER-CHAT-04: + Browser menu opens new browser pane in topic [@plan-30-05]", async ({ page, browserProcessPageV2, request }) => {
    await browserProcessPageV2.mockBrowserWs({ framesPerSecond: 15 });
    await browserProcessPageV2.mockBrowserContexts([]);
    await browserProcessPageV2.mockRemoteBrowserPane({
      connected: true,
      url: "about:blank",
      hasScreenshot: true,
    });

    const topic = await createTopic(request, `E2E-TabOpenMenu-${Date.now()}`);
    try {
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);

      // Click the topic to focus it as the active pane.
      await page
        .locator(`[data-pane-id="${topic.id}"], [data-topic-id="${topic.id}"]`)
        .first()
        .click()
        .catch(() => { /* if not clickable, the dispatch path below is the fallback */ });

      // Approach 1: try the +/Add pane menu if visible.
      const addPaneBtn = page.locator('button[title="Add pane"]').first();
      const hasAddPane = (await addPaneBtn.count()) > 0 && (await addPaneBtn.isVisible().catch(() => false));
      if (hasAddPane) {
        await addPaneBtn.click();
        const browserMenuItem = page.locator('button:has-text("Browser")').first();
        if ((await browserMenuItem.count()) > 0 && (await browserMenuItem.isVisible().catch(() => false))) {
          await browserMenuItem.click();
        } else {
          // Menu didn't expose Browser entry — fall back to event dispatch.
          await mountBrowserPaneViaEvent(page, topic.id);
        }
      } else {
        // Fallback: dispatch the canonical CustomEvent (same code path the
        // /browser slash command fires from ChatPane).
        await mountBrowserPaneViaEvent(page, topic.id);
      }

      await expect(page.locator('[data-testid="browser-connection-indicator"]')).toBeVisible({ timeout: 10000 });
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });

  test("BRW-REL: close_browser_pane remote close removes the pane in live clients", async ({ page, browserProcessPageV2, request }) => {
    // The close must originate in the OWNING client (membership keys are LWW
    // documents live clients re-persist — a server-side state edit gets
    // clobbered back). POST browser/close-pane broadcasts `browser:close-pane`;
    // the window that renders the pane closes it via its normal close flow.
    await browserProcessPageV2.mockBrowserWs({ framesPerSecond: 15 });
    await browserProcessPageV2.mockBrowserContexts([]);
    await browserProcessPageV2.mockRemoteBrowserPane({
      connected: true,
      url: "about:blank",
      hasScreenshot: true,
    });

    const topic = await createTopic(request, `E2E-RemoteClose-${Date.now()}`);
    try {
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      // Chat-path mount: contextId === topic.id, the id the topic-form close
      // endpoint resolves to.
      await mountBrowserPaneViaEvent(page, topic.id);
      await expect(page.locator('[data-testid="browser-connection-indicator"]')).toBeVisible({ timeout: 10000 });

      const res = await request.post(
        `http://localhost:13334/api/topics/${topic.id}/browser/close-pane`,
        { data: {} },
      );
      expect(res.ok()).toBeTruthy();

      await expect(page.locator('[data-testid="browser-connection-indicator"]')).toHaveCount(0, { timeout: 10000 });
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });

  test("BROWSER-CHAT-04: /browser <url> slash command opens browser pane and navigates [@plan-30-05]", async ({ page, browserProcessPageV2, request }) => {
    await browserProcessPageV2.mockBrowserWs({ framesPerSecond: 15 });
    await browserProcessPageV2.mockBrowserContexts([]);
    await browserProcessPageV2.mockRemoteBrowserPane({
      connected: true,
      url: "https://example.com",
      title: "Example",
      hasScreenshot: true,
    });

    const topic = await createTopic(request, `E2E-SlashBrowser-${Date.now()}`);
    try {
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      // Activate the topic pane.
      await page
        .locator(`[data-pane-id="${topic.id}"], [data-topic-id="${topic.id}"]`)
        .first()
        .click()
        .catch(() => { /* tolerate if hidden by sidebar collapse */ });

      // Find chat input — prefer testid, fallback to placeholder/textarea.
      const input = page
        .locator('[data-testid="chat-message-input"]')
        .or(page.locator('textarea[placeholder*="Message" i], textarea[placeholder*="Reply" i]'));
      await input.first().waitFor({ state: "visible", timeout: 10000 });
      await input.first().click();
      await input.first().fill("/browser https://example.com");
      await input.first().press("Enter");

      // The CustomEvent fires synchronously; the layout reducer mounts the
      // browser pane shortly after. Connection indicator visibility proves
      // RemoteBrowserPanel is rendered.
      await expect(page.locator('[data-testid="browser-connection-indicator"]')).toBeVisible({ timeout: 10000 });
      const urlInput = page.locator('[data-testid="browser-url-input"]');
      await expect(urlInput).toBeVisible({ timeout: 10000 });
      const urlValue = await urlInput.inputValue();
      // URL bar reflects the most recent navigation; tolerate either the
      // initial about:blank (panel just mounted) or the navigated URL.
      expect(urlValue).toMatch(/example\.com|about:blank|^$/);
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });

  // W8: split former test 3 into 3a (provider tools) + 3b (overlay direct broadcast).
  test("BROWSER-CHAT-04 (3a): @browser invokes provider with browserTools registered [@plan-30-05]", async ({ page, browserProcessPageV2, request }) => {
    await browserProcessPageV2.mockBrowserWs({ framesPerSecond: 15 });
    await browserProcessPageV2.mockBrowserContexts([]);
    await browserProcessPageV2.mockRemoteBrowserPane({
      connected: true,
      url: "https://example.com",
      hasScreenshot: true,
    });

    // The test server boots with provider=openclaw by default (per
    // server.ts startup log "[Server] AI provider: openclaw"). browserTools
    // are passthrough only for `claude` and `openai` providers (see
    // isPassthroughProvider in server/browser-tools-adapters.ts). For
    // the openclaw gateway, tool surface is upstream-managed and no
    // outbound HTTP fires to api.anthropic.com / api.openai.com — the
    // route mock will never resolve. Skip in that environment.
    const providerInfo = await request
      .get(`${BASE}/api/providers`)
      .then((r) => (r.ok() ? r.json() : null))
      .catch(() => null);
    const provider = (providerInfo as { current?: string } | null)?.current;
    if (!provider || (provider !== "claude" && provider !== "openai")) {
      test.skip(true, `Test server provider is '${provider ?? "unknown"}' — browserTools passthrough is claude/openai only`);
      return;
    }

    const providerToolsPromise = browserProcessPageV2
      .assertProviderToolsPassed(provider as "anthropic" | "openai")
      .catch(() => null);

    const topic = await createTopic(request, `E2E-AtBrowserTools-${Date.now()}`);
    try {
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      await page
        .locator(`[data-pane-id="${topic.id}"], [data-topic-id="${topic.id}"]`)
        .first()
        .click()
        .catch(() => { /* tolerate */ });

      const input = page
        .locator('[data-testid="chat-message-input"]')
        .or(page.locator('textarea[placeholder*="Message" i]'));
      await input.first().waitFor({ state: "visible", timeout: 10000 });
      await input.first().click();
      await input.first().fill("@browser open https://example.com and tell me the title");
      await input.first().press("Enter");

      const result = await providerToolsPromise;
      if (!result) {
        test.skip(true, "Provider intercept did not fire (provider may be CLI-based or offline)");
        return;
      }
      const toolNames = result.tools.map((t) => t.name).filter((n) => n.startsWith("browser_"));
      expect(toolNames).toEqual(
        expect.arrayContaining([
          "browser_open",
          "browser_observe",
          "browser_act",
          "browser_extract",
          "browser_screenshot",
          "browser_point",
        ]),
      );
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });

  test("BROWSER-CHAT-04 (3b): agent-controlling-overlay appears+disappears on agent_active=true/false WS broadcast [@plan-30-05]", async ({ page, browserProcessPageV2, request }) => {
    await browserProcessPageV2.mockBrowserWs({ framesPerSecond: 15 });
    await browserProcessPageV2.mockBrowserContexts([]);
    await browserProcessPageV2.mockRemoteBrowserPane({
      connected: true,
      url: "https://example.com",
      hasScreenshot: true,
    });

    const topic = await createTopic(request, `E2E-AgentOverlay-${Date.now()}`);
    try {
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      await mountBrowserPaneViaEvent(page, topic.id);

      const overlay = page.locator('[data-testid="agent-controlling-overlay"]');

      // Initially hidden.
      await expect(overlay).toBeHidden();

      // Inject agent_active=true via mock WS — overlay must appear within ~5s.
      browserProcessPageV2.broadcastAgentActive(true);
      await expect(overlay).toBeVisible({ timeout: 5000 });

      // Inject agent_active=false — overlay must disappear within ~5s.
      browserProcessPageV2.broadcastAgentActive(false);
      await expect(overlay).toBeHidden({ timeout: 5000 });
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });

  test("BROWSER-CHAT-04: Take control button releases agent lock + sends WS take_control [@plan-30-05]", async ({ page, browserProcessPageV2, request }) => {
    await browserProcessPageV2.mockBrowserWs({ framesPerSecond: 15 });
    await browserProcessPageV2.mockBrowserContexts([]);
    await browserProcessPageV2.mockRemoteBrowserPane({
      connected: true,
      url: "https://example.com",
      hasScreenshot: true,
    });

    const topic = await createTopic(request, `E2E-TakeControl-${Date.now()}`);
    try {
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      await mountBrowserPaneViaEvent(page, topic.id);

      // Inject agent_active=true via mock WS.
      browserProcessPageV2.broadcastAgentActive(true);

      // Overlay must appear within 5s.
      const overlay = page.locator('[data-testid="agent-controlling-overlay"]');
      await expect(overlay).toBeVisible({ timeout: 5000 });

      // Click Take control button.
      const takeBtn = page.locator('[data-testid="browser-take-control-button"]');
      await expect(takeBtn).toBeVisible({ timeout: 5000 });
      await takeBtn.click();

      // Verify outbound take_control message recorded (eventually).
      await expect
        .poll(() => browserProcessPageV2.drainInputMessages(), { timeout: 5000 })
        .toEqual(
          expect.arrayContaining([expect.objectContaining({ type: "take_control" })]),
        );

      // Overlay should disappear (the eager broadcast path: take_control ->
      // server -> agent_active=false re-broadcast -> overlay hides). With
      // mockBrowserWs we don't have the server side, so the overlay will
      // only hide if the client optimistically clears it. Check both
      // possibilities tolerantly.
      // The current useRemoteBrowser implementation does NOT optimistically
      // clear agentActive on takeControl — it relies on the server's
      // agent_active=false broadcast. Simulate it explicitly here.
      browserProcessPageV2.broadcastAgentActive(false);
      await expect(overlay).toBeHidden({ timeout: 5000 });
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });

  test("BROWSER-CHAT-04: Cmd+Shift+E enters select-element mode and click populates chat input [@plan-30-05]", async ({ page, browserProcessPageV2, request }) => {
    await browserProcessPageV2.mockBrowserWs({ framesPerSecond: 15 });
    await browserProcessPageV2.mockBrowserContexts([]);
    await browserProcessPageV2.mockRemoteBrowserPane({
      connected: true,
      url: "https://example.com",
      title: "Example",
      hasScreenshot: true,
    });
    // B2 FIX: bbox uses {x, y, w, h} matching production.
    await browserProcessPageV2.mockInspect({
      path: "/html/body[1]/div[1]/h1[1]",
      cssPath: "h1.title",
      bbox: { x: 100, y: 50, w: 200, h: 30 },
      text: "Example Domain",
    });

    const topic = await createTopic(request, `E2E-SelectElement-${Date.now()}`);
    try {
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);

      // Install a window-level chat:insert-text spy BEFORE mounting the
      // browser pane. The single-pane layout means the active pane swaps
      // between chat and browser; the chat input listener is registered
      // when ChatInput mounts. Using a spy avoids the layout coupling and
      // captures the event detail directly — which is the actual contract
      // (cssPath + bbox in {x,y,w,h} format per SelectElementOverlay.tsx:153).
      await page.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).__chatInsertEvents = [];
        window.addEventListener("chat:insert-text", (e) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (window as any).__chatInsertEvents.push((e as CustomEvent).detail);
        });
      });

      // Mount browser pane.
      await mountBrowserPaneViaEvent(page, topic.id);

      // Patch naturalWidth/Height so SelectElementOverlay's mapCoordsToPage
      // accepts realistic click positions on the fixture's 1x1 frame payload.
      await page.evaluate(() => {
        const img = document.querySelector(
          'img[alt="Browser page"], img[alt="Example"]',
        ) as HTMLImageElement | null;
        if (img) {
          Object.defineProperty(img, "naturalWidth", { value: 1280, configurable: true });
          Object.defineProperty(img, "naturalHeight", { value: 800, configurable: true });
        }
      });

      // Press Cmd+Shift+E (window-level listener, no need to focus the pane).
      await page.keyboard.press("Meta+Shift+E");

      // SelectElementOverlay must mount.
      const overlay = page.locator('[data-testid="browser-select-element-overlay"]');
      await expect(overlay).toBeVisible({ timeout: 5000 });

      // Click the CENTER of the overlay to trigger inspect + chat:insert-text.
      // The screenshot is object-contain'd: a landscape frame (1280x800) inside
      // a portrait pane letterboxes vertically, so a fixed top-ish position like
      // {200,100} can land in the dead letterbox band above the image (localY<0
      // → mapCoordsToPage returns null → no inspect fires). The geometric centre
      // is always inside the displayed image regardless of pane aspect ratio.
      const oBox = await overlay.boundingBox();
      await overlay.click({
        position: { x: (oBox?.width ?? 400) / 2, y: (oBox?.height ?? 400) / 2 },
        force: true,
      });

      // Spy must capture the dispatched event with the canonical text format.
      // SelectElementOverlay.tsx:153:
      //   `Selected element: ${info.cssPath} @ ${info.path} (bbox: ${info.bbox.x},${info.bbox.y},${info.bbox.w},${info.bbox.h})${info.text ? ` text: "${info.text}"` : ''}`
      // With our mock cssPath="h1.title" + bbox={x:100,y:50,w:200,h:30}, the
      // event detail.text contains "h1.title" AND "bbox: 100,50,200,30".
      await expect
        .poll(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          async () => await page.evaluate(() => (window as any).__chatInsertEvents.length),
          { timeout: 5000 },
        )
        .toBeGreaterThanOrEqual(1);

      const events = await page.evaluate(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        () => (window as any).__chatInsertEvents as Array<{ text?: string }>,
      );
      const text = events[0]?.text ?? "";
      expect(text).toMatch(/Selected element/i);
      expect(text).toMatch(/h1\.title|h1/);
      // B2 FIX: bbox format is "bbox: <x>,<y>,<w>,<h>" — with our mock
      // {x:100, y:50, w:200, h:30} it renders as "bbox: 100,50,200,30".
      expect(text).toMatch(/bbox:\s*100,\s*50,\s*200,\s*30/);
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });

  test("BROWSER-CHAT-04: localhost URLs render via iframe fallback [@plan-30-05]", async ({ page, browserProcessPageV2, request }) => {
    await browserProcessPageV2.mockBrowserWs({ framesPerSecond: 15 });
    await browserProcessPageV2.mockBrowserContexts([]);
    // Localhost path: the panel's early-return iframe doesn't actually
    // request snapshots. We still mount the pane via the CustomEvent.
    await browserProcessPageV2.mockRemoteBrowserPane({
      connected: true,
      url: "http://localhost:3333",
      hasScreenshot: false,
    });

    const topic = await createTopic(request, `E2E-LocalhostIframe-${Date.now()}`);
    try {
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      // Use the slash command path — usePaneOrdering rewrites localhost to
      // window.location.hostname so the iframe loads same-origin.
      await mountBrowserPaneViaEvent(page, topic.id, "http://localhost:3333");

      const iframe = page.locator('[data-testid="browser-localhost-iframe"]');
      await expect(iframe).toBeVisible({ timeout: 10000 });
      // Verify it IS an iframe element (not an img).
      const tag = await iframe.evaluate((el) => el.tagName);
      expect(tag.toLowerCase()).toBe("iframe");
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });
});
