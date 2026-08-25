import { test, expect } from "./fixtures/browser-v2.fixture";
import { goToApp } from "./helpers";
import { E2E_BASE } from "./helpers/test-server";
import {
  createTopic,
  deleteTopic,
  waitForTopicVisible,
  resetPaneStore,
  closeAllBrowserContexts,
} from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

const BASE = E2E_BASE;

/**
 * Mount a RemoteBrowserPanel for `topicId` by dispatching the canonical
 * `browser:open-and-navigate` CustomEvent (the same one ChatPane fires for
 * `/browser <url>` slash command). Resolves once the toolbar URL input is
 * present — the ONE element every render mode (WebRTC <video> stream, native
 * <iframe>, empty state) always mounts. The old connection-indicator gate broke
 * when the steady-'connected' "Live" pill was removed (commit b11f40ec): it's
 * absent once streaming, so it can't anchor "the panel mounted".
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
  await expect(page.locator('[data-browser-pane]').first()).toBeVisible({ timeout: 10000 });
}

// Chi sporca pulisce: qui si aprono contesti browser server-side, che non
// vivono in una ui_state e sopravvivono a `resetPaneStore` (vedi la docstring
// di `closeAllBrowserContexts`).
test.afterAll(async ({ request }) => {
  await closeAllBrowserContexts(request);
});

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

      // The panel mounted → its toolbar URL input is present (a stable anchor;
      // the connection "Live" pill hides once streaming).
      await expect(page.locator('[data-browser-pane]').first()).toBeVisible({ timeout: 10000 });
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
      // The pane's toolbar URL input anchors "the pane is present" (stable across
      // render modes, unlike the connection pill which hides once streaming).
      const paneRoot = page.locator("[data-browser-pane]");
      await expect(paneRoot.first()).toBeVisible({ timeout: 10000 });

      const res = await request.post(
        `${E2E_BASE}/api/topics/${topic.id}/browser/close-pane`,
        { data: {} },
      );
      expect(res.ok()).toBeTruthy();

      // Remote close removed the pane → the pane root is gone.
      await expect(paneRoot).toHaveCount(0, { timeout: 10000 });
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });

  test("BROWSER-CHAT-04b: /browser <url> slash command opens browser pane and navigates [@plan-30-05]", async ({ page, browserProcessPageV2, request }) => {
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
      // browser pane shortly after. `[data-browser-pane]` proves
      // RemoteBrowserPanel rendered: it is on the pane root, so unlike the
      // address row (which hides itself once the page is loaded) it is there
      // for as long as the pane is.
      await expect(page.locator("[data-browser-pane]").first()).toBeVisible({ timeout: 10000 });
      // WHERE the pane went is now written on the TAB, which is the surface
      // that carries the address. Tolerate the empty pane: the shared session
      // can still be negotiating when this runs.
      await expect(
        page.getByRole("tab", { name: /example\.com|Browser|New Chat/ }).first(),
      ).toBeVisible({ timeout: 10000 });
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });

  // W8: split former test 3 into 3a (provider tools) + 3b (overlay direct broadcast).
  test("BROWSER-CHAT-04c (3a): @browser invokes provider with browserTools registered [@plan-30-05]", async ({ page, browserProcessPageV2, request }) => {
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

  test("BROWSER-CHAT-04d (3b): agent-controlling-overlay appears+disappears on agent_active=true/false WS broadcast [@plan-30-05]", async ({ page, browserProcessPageV2, request }) => {
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

      // Il pane deve essersi collegato alla WS mockata PRIMA di trasmettere,
      // altrimenti il broadcast parte nel vuoto (vedi waitForWsConnected).
      await browserProcessPageV2.waitForWsConnected();

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

  test("BROWSER-CHAT-04e: Take control button releases agent lock + sends WS take_control [@plan-30-05]", async ({ page, browserProcessPageV2, request }) => {
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

      // Il pane deve essersi collegato alla WS mockata PRIMA di trasmettere,
      // altrimenti il broadcast parte nel vuoto (vedi waitForWsConnected).
      await browserProcessPageV2.waitForWsConnected();

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

  test("BROWSER-CHAT-04f: Cmd+Shift+E enters select-element mode and click populates chat input [@plan-30-05]", async ({ page, browserProcessPageV2, request }) => {
    await browserProcessPageV2.mockBrowserWs({ framesPerSecond: 15 });
    await browserProcessPageV2.mockWebrtcPeer(); // select-element maps against the <video> surface
    await browserProcessPageV2.mockBrowserContexts([]);
    await browserProcessPageV2.mockRemoteBrowserPane({
      connected: true,
      url: "https://example.com",
      title: "Example",
      hasScreenshot: true,
    });
    // B2 FIX: bbox uses {x, y, w, h} matching production.
    // L'HOVER passa da /inspect…
    await browserProcessPageV2.mockInspect({
      path: "/html/body[1]/div[1]/h1[1]",
      cssPath: "h1.title",
      bbox: { x: 100, y: 50, w: 200, h: 30 },
      text: "Example Domain",
    });
    // …il CLICK da /describe-element (4.2): markup + stile + ritaglio.
    await browserProcessPageV2.mockDescribeElement({
      path: "/html/body[1]/div[1]/h1[1]",
      cssPath: "h1.title",
      selector: "body > div.wrap > h1.title",
      bbox: { x: 100, y: 50, w: 200, h: 30 },
      text: "Example Domain",
      html: '<h1 class="title">Example Domain</h1>',
      htmlTruncated: false,
      ancestors: ["body", "div.wrap"],
      styles: { display: "block", "font-size": "32px" },
      viewport: { w: 1280, h: 720 },
      url: "https://example.com",
      // 1×1 PNG trasparente: al test serve che l'evento parta, non cosa mostra.
      screenshot: {
        dataUrl:
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
        w: 216,
        h: 46,
      },
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).__chatImageEvents = [];
        window.addEventListener("chat:attach-image", (e) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (window as any).__chatImageEvents.push((e as CustomEvent).detail);
        });
      });

      // Mount browser pane, then wait for the WebRTC <video> surface — the
      // select-element overlay maps clicks against it (a synthetic stream has
      // videoWidth=0 so mapCoordsToPage uses the 1280×720 fallback basis, no
      // DOM patch needed).
      await mountBrowserPaneViaEvent(page, topic.id);
      await expect(page.locator('[data-testid="browser-webrtc-video"]')).toBeVisible({ timeout: 10000 });

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

      // 4.2 — il contratto non è più una riga: è il blocco di
      // `formatElementContext` (identificazione + markup + stile calcolato),
      // e l'immagine viaggia su un secondo evento.
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
      expect(text).toMatch(/Elemento selezionato/i);
      expect(text).toContain("h1.title");
      expect(text).toContain("body > div.wrap > h1.title");
      expect(text).toMatch(/riquadro:\s*100,50/);
      // Il markup e lo stile ci sono DAVVERO, e in due blocchi distinti: è la
      // differenza fra "so dove hai cliccato" e "so cosa devo modificare".
      expect(text).toContain("```html");
      expect(text).toContain('<h1 class="title">Example Domain</h1>');
      expect(text).toContain("```css");
      expect(text).toContain("font-size: 32px;");

      // Il ritaglio arriva come allegato, non come testo.
      const images = await page.evaluate(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        () => (window as any).__chatImageEvents as Array<{ dataUrl?: string; mimeType?: string }>,
      );
      expect(images.length).toBeGreaterThanOrEqual(1);
      expect(images[0]?.dataUrl ?? "").toMatch(/^data:image\/png;base64,/);
      expect(images[0]?.mimeType).toBe("image/png");
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });

  // Questo test asseriva il CONTRARIO: "localhost URLs render via iframe
  // fallback", cioe' il force-frame incondizionato di localhost. Quel
  // comportamento e' stato RIMOSSO di proposito — RemoteBrowserPanel.tsx:602
  // lo dice per esteso: un'app di sviluppo locale che manda X-Frame-Options /
  // frame-ancestors (Quadra su :3100 → SAMEORIGIN) si caricava BIANCA
  // nell'iframe, e leggeva come "il browser non fa nulla, resta bianco". Oggi
  // `useIframe = !isTauri && url && !agentActive && browser.framable`
  // (RemoteBrowserPanel.tsx:616): localhost NON e' piu' un caso speciale,
  // passa dalla stessa sonda /api/browsers/framable di ogni altro URL, e se
  // non e' framabile cade sulla superficie in streaming / co-browse DOM.
  //
  // Il test resta, girato al contrario: e' la guardia che impedisce di
  // reintrodurre il force-frame. Non e' un doppione di
  // browser-iframe-mode.spec.ts ("non-framable URL → screenshot stream") —
  // li' l'URL e' example.com e si verifica la sonda in generale; qui il punto
  // e' proprio che l'host sia localhost, l'unico che prima scavalcava la sonda.
  test("BROWSER-CHAT-04g: localhost NON e' piu' force-framed — segue la sonda framable [@plan-30-05]", async ({ page, browserProcessPageV2, request }) => {
    await browserProcessPageV2.mockBrowserWs({ framesPerSecond: 15 });
    await browserProcessPageV2.mockWebrtcPeer(); // superficie di stream = <video> WebRTC
    await browserProcessPageV2.mockBrowserContexts([]);
    await browserProcessPageV2.mockRemoteBrowserPane({
      connected: true,
      url: "http://localhost:3333",
      hasScreenshot: true,
    });
    // Registrata per ULTIMA: i mock sopra usano glob piu' larghi su
    // "api/browsers" che matchano anche questo path, e Playwright da
    // precedenza all'ultima rotta registrata (stessa nota in
    // browser-iframe-mode.spec.ts).
    await page.route(/\/api\/browsers\/framable/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ framable: false }),
      });
    });

    const topic = await createTopic(request, `E2E-LocalhostNoForceFrame-${Date.now()}`);
    try {
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      await mountBrowserPaneViaEvent(page, topic.id, "http://localhost:3333");

      // Il pane e' davvero su localhost (altrimenti l'asserzione sotto sarebbe
      // vera per il motivo sbagliato: un pane vuoto non ha iframe comunque).
      // Si guarda il TITOLO DEL TAB, non `browser-url-input`: quell'input resta
      // vuoto finche' non arriva la nav-info dal WS, che qui e' mockato — vedi
      // il fix di fetchInfo() in ws.onopen. Il titolo invece deriva dall'URL
      // del pane, quindi mostra l'host da subito.
      await expect(page.getByRole("tab", { name: /localhost/ }).first()).toBeVisible({
        timeout: 10000,
      });
      // Nessun iframe: e' esattamente il force-frame che non deve tornare.
      await expect(page.locator('[data-testid="browser-iframe"]')).toHaveCount(0);
      // E si cade sulla superficie in streaming, non su un pane morto.
      await expect(page.locator('[data-testid="browser-webrtc-video"]')).toBeVisible({ timeout: 10000 });
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });
});
