import { readFileSync } from "fs";
import { resolve as resolvePath } from "path";
import { test, expect } from "./fixtures/browser-v2.fixture";
import { goToApp } from "./helpers";
import { closeAllBrowserContexts, createTopic, deleteTopic, waitForTopicVisible, resetPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

// Hermetic boundary: this file restarts from the globalSetup baseline, not from
// whatever the previous specs left behind. See fixtures/hermetic.ts.
hermetic(test);

// Whoever makes the mess cleans it: see the docstring of `closeAllBrowserContexts`.
test.afterAll(async ({ request }) => {
  await closeAllBrowserContexts(request);
});

/**
 * WHAT THE SPECTATOR'S PANE DOES, PROVED WHERE IT IS CHEAP TO PROVE.
 *
 * The other half of TOPIC-BROWSER-05 (the arbitration itself, against a real
 * server-side Chromium) lives in `browser-viewport-arbiter.spec.ts` and only
 * runs nightly. These two cases do NOT need a server-side browser, so they run
 * on every pull request, and that is the point of the split: the three lines
 * that carry this behaviour (the claim in `useRemoteBrowser`, the rrweb
 * ViewportResize handler in `DomCoBrowse`, the fit in `browserFit`) used to be
 * removable with the PR gate staying green.
 *
 *   1. the centring: the geometry is a function of the container/page pair, so
 *      the mock harness is not a weaker witness here, it is a deterministic one.
 *   2. the ORDER in which a spectator's first tap leaves: the input first, the
 *      viewport claim after it. Reversed, the claim reflows the shared page
 *      before the click is dispatched and the tap lands where nothing is any
 *      more (x=1000 on a page that has just become 390 wide).
 *
 * @covers TOPIC-BROWSER-05
 */

/** The rrweb burst captured offline, reused here with a wider Meta. */
const RRWEB_EVENTS = JSON.parse(
  readFileSync(resolvePath(__dirname, "fixtures/rrweb-sample.json"), "utf-8"),
) as { type: number; data?: Record<string, unknown> }[];

/** The sample's Meta says 900x600; this needs a desk-sized page instead. */
const RECORDED_WIDTH = 1280;
const RECORDED_HEIGHT = 800;

function eventsWithRecordedViewport(width: number, height: number): unknown[] {
  return RRWEB_EVENTS.map((event) =>
    event.type === 4
      ? { ...event, data: { ...(event.data ?? {}), width, height } }
      : event,
  );
}

test.describe("La pagina in scala sta al centro", () => {
  test.use({ viewport: { width: 900, height: 780 } });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, []);
  });

  test("la pagina che non riempie il riquadro sta al centro, e segue i cambi di viewport", async ({ page, browserProcessPageV2, request }) => {
    await browserProcessPageV2.mockBrowserWs({ framesPerSecond: 10 });
    await browserProcessPageV2.mockBrowserContexts([]);
    await browserProcessPageV2.mockRemoteBrowserPane({
      connected: true,
      url: "https://example.com",
      title: "Example",
      hasScreenshot: true,
    });
    // The shared page was recorded by a desk: this spectator's mirror is
    // narrower and has to show it scaled.
    browserProcessPageV2.mockDomCoBrowse(eventsWithRecordedViewport(RECORDED_WIDTH, RECORDED_HEIGHT));

    const topic = await createTopic(request, `E2E-FIT-${Date.now()}`);
    try {
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      await page.evaluate(
        ({ tid, url }) => {
          window.dispatchEvent(new CustomEvent("browser:open-and-navigate", { detail: { topicId: tid, url } }));
        },
        { tid: topic.id, url: "https://example.com" },
      );
      await expect(page.locator("[data-browser-pane]").first()).toBeVisible({ timeout: 10_000 });

      const container = page.locator('[data-testid="browser-dom-cobrowse"]').first();
      const overlay = page.locator('[data-testid="browser-dom-input-overlay"]').first();
      await expect(container).toBeVisible({ timeout: 10_000 });
      await expect(overlay).toBeVisible({ timeout: 10_000 });
      // THE MIRROR MUST BE THE SURFACE ON TOP, not merely an element with a box.
      // Playwright's `toBeVisible` means "non-empty box and not hidden": a
      // rectangle COVERED by the pane's new-tab page passes it too, and such a
      // green would measure the geometry of a surface nobody sees. Reading the
      // reconstructed content inside the iframe is what ties the measurement to
      // what the user has in front of them.
      await expect(container.frameLocator("iframe").locator("#hi")).toHaveText("DOM COBROWSE OK", { timeout: 10_000 });

      /** The four margins between the scaled rectangle and the container holding it. */
      const margins = async (): Promise<{ left: number; right: number; top: number; bottom: number; width: number; height: number }> => {
        const outer = await container.boundingBox();
        const inner = await overlay.boundingBox();
        if (!outer || !inner) throw new Error("mirror non misurabile: uno dei due riquadri non ha un box");
        return {
          left: inner.x - outer.x,
          right: outer.x + outer.width - (inner.x + inner.width),
          top: inner.y - outer.y,
          bottom: outer.y + outer.height - (inner.y + inner.height),
          width: inner.width,
          height: inner.height,
        };
      };

      // The size settles on the first fullsnapshot; `expect.poll` waits for that,
      // not for a tick. With no content the rectangle would be 0x0.
      await expect
        .poll(async () => (await margins()).width > 0, { timeout: 10_000, message: "il mirror non ha ancora preso una misura" })
        .toBe(true);

      const landscape = await margins();
      // Centred: opposite margins match. The tight axis has both at zero, which
      // is still centred; the loose one carries the leftover space, split in
      // two. And it is that leftover which says the page is NOT pinned to the
      // top-left corner, which is how it used to render.
      expect(Math.abs(landscape.left - landscape.right), `margini orizzontali diversi: ${JSON.stringify(landscape)}`).toBeLessThanOrEqual(2);
      expect(Math.abs(landscape.top - landscape.bottom), `margini verticali diversi: ${JSON.stringify(landscape)}`).toBeLessThanOrEqual(2);
      expect(
        Math.max(landscape.left, landscape.top),
        `la pagina riempie il riquadro su entrambi gli assi: non c'e' nessuna scala da centrare (${JSON.stringify(landscape)})`,
      ).toBeGreaterThan(2);
      // Scaled, not cropped: the recorded page keeps its aspect ratio.
      expect(landscape.width / landscape.height).toBeCloseTo(RECORDED_WIDTH / RECORDED_HEIGHT, 1);

      // The context's driver changes (TOPIC-BROWSER-05) and the page moves to a
      // phone-sized viewport: rrweb says so with an incremental ViewportResize,
      // not with a new Meta. Reading only the Meta left this spectator scaling
      // on the first size forever.
      const portraitWidth = 420;
      const portraitHeight = 900;
      browserProcessPageV2.sendDomEvent({
        type: 3,
        data: { source: 4, width: portraitWidth, height: portraitHeight },
        timestamp: Date.now(),
      });

      await expect
        .poll(async () => {
          const box = await margins();
          return Number((box.width / box.height).toFixed(2));
        }, { timeout: 10_000, message: "il mirror non si e' rifittato sul nuovo viewport" })
        .toBe(Number((portraitWidth / portraitHeight).toFixed(2)));

      const portrait = await margins();
      expect(Math.abs(portrait.left - portrait.right), `margini orizzontali diversi dopo il refit: ${JSON.stringify(portrait)}`).toBeLessThanOrEqual(2);
      expect(Math.abs(portrait.top - portrait.bottom), `margini verticali diversi dopo il refit: ${JSON.stringify(portrait)}`).toBeLessThanOrEqual(2);
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });
});

test.describe("Il primo tocco di uno spettatore parte prima della rivendicazione", () => {
  test.use({ viewport: { width: 900, height: 780 } });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, []);
  });

  test("l'input precede il resize che rivendica il viewport", async ({ page, browserProcessPageV2, request }) => {
    await browserProcessPageV2.mockBrowserWs({ framesPerSecond: 10 });
    await browserProcessPageV2.mockBrowserContexts([]);
    await browserProcessPageV2.mockRemoteBrowserPane({
      connected: true,
      url: "https://example.com",
      title: "Example",
      hasScreenshot: true,
    });
    browserProcessPageV2.mockDomCoBrowse(eventsWithRecordedViewport(RECORDED_WIDTH, RECORDED_HEIGHT));

    const topic = await createTopic(request, `E2E-CLAIM-${Date.now()}`);
    try {
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      await page.evaluate(
        ({ tid, url }) => {
          window.dispatchEvent(new CustomEvent("browser:open-and-navigate", { detail: { topicId: tid, url } }));
        },
        { tid: topic.id, url: "https://example.com" },
      );
      await expect(page.locator("[data-browser-pane]").first()).toBeVisible({ timeout: 10_000 });

      const overlay = page.locator('[data-testid="browser-dom-input-overlay"]').first();
      await expect(overlay).toBeVisible({ timeout: 10_000 });
      // The mirror has to be the surface on top before a click on it means
      // anything: see the sibling case for why this assertion is here.
      await expect(
        page.locator('[data-testid="browser-dom-cobrowse"]').first().frameLocator("iframe").locator("#hi"),
      ).toHaveText("DOM COBROWSE OK", { timeout: 10_000 });

      // Everything the pane said while it was opening (the first size, the
      // stream setup) is water under the bridge: the window we measure opens
      // with the click.
      browserProcessPageV2.drainInputMessages();
      await overlay.click({ position: { x: 120, y: 90 } });

      const said: { type?: string; driving?: boolean }[] = [];
      const indexOfInput = () => said.findIndex((m) => m.type === "input");
      const indexOfClaim = () => said.findIndex((m) => m.type === "resize" && m.driving === true);
      await expect
        .poll(() => {
          said.push(...(browserProcessPageV2.drainInputMessages() as { type?: string; driving?: boolean }[]));
          return indexOfInput() >= 0 && indexOfClaim() >= 0;
        }, { timeout: 10_000, message: `il click non ha prodotto input + rivendicazione: ${JSON.stringify(said)}` })
        .toBe(true);

      expect(
        indexOfInput(),
        `la rivendicazione del viewport e' partita prima dell'input: ${JSON.stringify(said)}`,
      ).toBeLessThan(indexOfClaim());
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });
});
