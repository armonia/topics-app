import { test, expect } from "./fixtures/browser-v2.fixture";
import { goToApp } from "./helpers";
import {
  createTopic,
  deleteTopic,
  waitForTopicVisible,
  resetPaneStore,
  closeAllBrowserContexts,
} from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";
import { expectNothingOverThePage } from "./helpers/browser-geometry";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

/**
 * TOPIC-BROWSER-03 — NOTHING PERMANENT OVER THE PAGE.
 *
 * Three pills used to float on top of a browser pane's page: the connection dot
 * (top-right), the engine switch (top-left) and the render switch (bottom-left).
 * Two of them were SWITCHES parked over the very content they switched.
 *
 * They are gone. What the pane IS now reaches the tab as ONE icon between
 * favicon and title, drawn only when this pane is not the default kind, and the
 * two switches live in the Session section of the tab's sheet.
 *
 * WHAT THIS FILE WOULD CATCH THAT THE OTHER FOUR DO NOT. `browser-engine-switch`
 * and `browser-dom-cobrowse` prove the switches WORK where they now are, and
 * `browser-ws-streaming` reads the connection off the tab. None of them asserts
 * the absence: a pill could come back over the page and all four would stay
 * green.
 *
 * AND THE ABSENCE IS MEASURED AS GEOMETRY, not as three names counted to zero.
 * The pills that went away were `browser-connection-indicator`,
 * `browser-engine-toggle` and `browser-render-toggle` — written as three
 * `toHaveCount(0)` this file would be green over any app in existence, this one
 * included if tomorrow it replants a pill under a fourth name. So the question
 * asked is the requirement's own: is ANYTHING layered over the page area of a
 * browser pane? See `elementsOverThePage` for the rect, the candidates and the
 * four admitted exceptions, each with its reason.
 *
 * Every assertion runs against a pane that is genuinely up (the <video> or the
 * <iframe> is on screen): an absence asserted against a pane that never mounted
 * is free.
 *
 * @covers TOPIC-BROWSER-03
 */

async function mountBrowserPane(
  page: import("@playwright/test").Page,
  topicId: string,
  url = "https://example.com",
): Promise<void> {
  await page.evaluate(
    ({ tid, u }) => {
      window.dispatchEvent(
        new CustomEvent("browser:open-and-navigate", { detail: { topicId: tid, url: u } }),
      );
    },
    { tid: topicId, u: url },
  );
  await expect(page.locator("[data-browser-pane]").first()).toBeVisible({ timeout: 10_000 });
}

/**
 * Pin this pane to the SHARED server session before it mounts.
 *
 * For a chat topic the browser contextId IS the topic id (see the
 * `browser:open-and-navigate` handler in `usePaneOrdering`), so the per-device
 * preference key is predictable — and it has to be written BEFORE the mount,
 * because the pane reads it once to decide which side it renders.
 */
async function pinShared(page: import("@playwright/test").Page, contextId: string): Promise<void> {
  await page.evaluate((ctx) => {
    localStorage.setItem(`topics.browser.shared.${ctx}`, "1");
  }, contextId);
}

/** Open the tab's sheet. The dots come out on hover, so the pointer goes over
 *  the pane's tab first. */
async function openTabSheet(page: import("@playwright/test").Page): Promise<void> {
  await page.locator('[data-pane-id^="browser:"]').first().hover();
  await page.getByTestId("browser-tab-menu").first().click();
  await expect(page.getByTestId("browser-tab-sheet")).toBeVisible({ timeout: 10_000 });
}

// Chi sporca pulisce: vedi la docstring di `closeAllBrowserContexts`.
test.afterAll(async ({ request }) => {
  await closeAllBrowserContexts(request);
});

test.describe("TOPIC-BROWSER-03 — niente di permanente sopra la pagina", () => {
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, []);
  });

  test("una scheda condivisa: niente sopra la pagina, l'icona nella tab, i commutatori nel foglio", async ({ page, browserProcessPageV2, request }) => {
    test.info().annotations.push({ type: "spec", description: "TOPIC-BROWSER-03" });
    await browserProcessPageV2.mockBrowserWs({ framesPerSecond: 15 });
    await browserProcessPageV2.mockWebrtcPeer(); // streaming surface = WebRTC <video>
    await browserProcessPageV2.mockBrowserContexts([]);
    await browserProcessPageV2.mockRemoteBrowserPane({
      connected: true, url: "https://example.com", title: "Example", hasScreenshot: true,
    });
    // Stay on the streaming branch (the iframe one has no engine at all), and
    // advertise a real Chromium so the engine switch has a second position to
    // offer — without the capability the row is not drawn, and the scenario's
    // "il foglio contiene i commutatori" would be untestable.
    await page.route(/\/api\/browsers\/framable/, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ framable: false }) }));
    await browserProcessPageV2.mockEngines({ enabled: true, available: true, engine: "Google Chrome", extensions: 7 });

    const topic = await createTopic(request, `E2E-NoPills-${Date.now()}`);
    try {
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      await pinShared(page, topic.id);
      await mountBrowserPane(page, topic.id);

      // The pane is genuinely up: the streaming surface is on screen. Every
      // assertion below is about a pane that exists.
      await expect(page.getByTestId("browser-webrtc-video").first()).toBeVisible({ timeout: 10_000 });

      await expectNothingOverThePage(page, "qualcosa è piantato sopra la pagina di una pane condivisa");

      // The tab carries the sharing icon: this pane is not the default kind.
      const typeIcon = page.getByTestId("browser-tab-type-icon").first();
      await expect(typeIcon).toBeVisible({ timeout: 10_000 });
      await expect(typeIcon).toHaveAttribute("data-kind", "shared");

      // …and the two switches are in the sheet, where a click can reach them.
      await openTabSheet(page);
      const engine = page.getByTestId("browser-tab-engine");
      await expect(engine).toBeVisible({ timeout: 10_000 });
      // The server's Playwright is NOT labelled «Nativo»: that word already
      // names the device's own webview, a different thing entirely.
      await expect(engine).toContainText("Playwright");
      await expect(engine).not.toContainText("Nativo");
      await expect(page.getByTestId("browser-tab-render")).toBeVisible({ timeout: 10_000 });

      // Opening the sheet is the other half of the rule: the surface that holds
      // the switches must not leave anything else behind over the page. The
      // sheet itself is admitted — it covers on purpose, and only while open.
      await expectNothingOverThePage(page, "aprire il foglio ha lasciato qualcosa sopra la pagina");
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });

  test("una scheda normale: la tab non porta nessuna icona di tipo", async ({ page, browserProcessPageV2, request }) => {
    test.info().annotations.push({ type: "spec", description: "TOPIC-BROWSER-03" });
    await browserProcessPageV2.mockBrowserWs({ framesPerSecond: 15 });
    await browserProcessPageV2.mockBrowserContexts([]);
    await browserProcessPageV2.mockRemoteBrowserPane({
      connected: true, url: "https://example.com", title: "Example", hasScreenshot: true,
    });
    // THE DEFAULT KIND on the web client: the page in a real <iframe>, i.e. this
    // device's own engine, nothing shared, no server stream to be connected to.
    // Registered LAST so it wins over the broader /api/browsers/* mocks.
    await page.route(/\/api\/browsers\/framable/, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ framable: true }) }));

    const topic = await createTopic(request, `E2E-NoKind-${Date.now()}`);
    try {
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      await mountBrowserPane(page, topic.id);

      // The iframe proves which branch rendered — and it is the branch with no
      // connection, no engine and no render mode to report.
      await expect(page.getByTestId("browser-iframe")).toBeVisible({ timeout: 10_000 });

      // No icon at all: a glyph every tab carries is not information, it is
      // width taken from the label.
      await expect(page.getByTestId("browser-tab-type-icon")).toHaveCount(0);
      await expectNothingOverThePage(page, "la scheda predefinita ha qualcosa sopra la pagina");
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });
});
