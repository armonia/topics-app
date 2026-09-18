import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { goToApp } from "./helpers";
import {
  createTopic,
  deleteTopic,
  waitForTopicVisible,
  resetPaneStore,
  closeAllBrowserContexts,
} from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

// Hermetic boundary: this file starts from the globalSetup baseline, not from
// whatever the previous specs left behind. See fixtures/hermetic.ts.
hermetic(test);

/**
 * A LOOPBACK URL OPENED FROM THE CHAT HAS TO NAVIGATE, OR SAY WHY NOT.
 *
 * The defect this closes (measured 2026-09-14, card 30f55ca9): on the WEB
 * client a pane pointed at a loopback address — a dev server, a task preview —
 * stayed on the new-tab page forever. The `/api/browsers/framable` probe
 * refuses every loopback by design (its SSRF guard, `isSafePublicUrl`, must not
 * be loosened), so there is no iframe to render; the pane then has to fall back
 * to the server-rendered surface, which is the one path that CAN reach loopback
 * because the headless browser runs on the server's own machine.
 *
 * Nothing is mocked here on purpose. The mocked twin of this case already
 * passes (`browser-dom-cobrowse.spec.ts`, "a non-framable localhost app renders
 * via DOM co-browse"): the decision logic was never the broken half. The page
 * is served by THIS test process on a loopback port, which is both the shortest
 * possible dependency and the exact shape of the real report.
 *
 * @covers BROWSER-CHAT-04
 */
const PAGE_MARKER = "loopback page served by the test";

let pageServer: Server;
let loopbackUrl: string;

test.beforeAll(async () => {
  pageServer = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><html><head><title>Loopback</title></head>` +
        `<body><h1 id="marker">${PAGE_MARKER}</h1></body></html>`,
    );
  });
  await new Promise<void>((resolve) => pageServer.listen(0, "127.0.0.1", resolve));
  const { port } = pageServer.address() as AddressInfo;
  loopbackUrl = `http://127.0.0.1:${port}/`;
});

/**
 * LAUNCH CHROMIUM BEFORE THE CLOCK STARTS.
 *
 * The server starts its headless browser on first use, and on a machine that
 * also runs the fleet that launch alone can take a minute. Inside the test it
 * was spending the whole budget: every run failed the first attempt and passed
 * the retry, which reuses the warm browser - a flake that was measuring the
 * cold start, not the pane. Paying for it here, once, in a hook with its own
 * timeout, leaves the test budget for the thing under test.
 */
test.beforeAll(async ({ request }) => {
  const launched = await request.post(`/api/browsers/warm-${Date.now()}/agent/open`, {
    data: { url: "about:blank" },
    timeout: 180_000,
  });
  expect(launched.ok()).toBe(true);
});

test.afterAll(async ({ request }) => {
  // Whoever makes the mess cleans it up: see the `closeAllBrowserContexts` docstring.
  await closeAllBrowserContexts(request);
  await new Promise<void>((resolve) => pageServer.close(() => resolve()));
});

test.describe("BROWSER-CHAT-04 — a loopback URL from the chat never dies on the new-tab page", () => {
  test.beforeEach(async ({ request }, testInfo) => {
    testInfo.annotations.push({ type: "spec", description: "BROWSER-CHAT-04" });
    await resetPaneStore(request, []);
  });

  test("the framable probe still refuses loopback (the SSRF guard is untouched)", async ({ request }) => {
    const res = await request.get(`/api/browsers/framable?url=${encodeURIComponent(loopbackUrl)}`);
    expect(res.ok()).toBe(true);
    expect(await res.json()).toEqual({ framable: false });
  });

  test("the pane renders the loopback page instead of the mute new tab", async ({ page, request }) => {
    // The server launches a headless browser, opens a page and navigates it:
    // the 30s file ceiling is not enough for that chain on a busy machine.
    // 180s, and the number is the COLD START. The first navigation on a fresh
    // server has to launch Chromium before it can open anything, and on a
    // machine that also runs the fleet that launch alone ate the old 45s
    // budget: the run failed, the retry reused the warm browser and passed in
    // seconds. That is a budget too small for the slowest legitimate path, not
    // a flaky behaviour, so the budget is what moves.
    test.setTimeout(180_000);

    const topic = await createTopic(request, `E2E-Loopback-${Date.now()}`);
    try {
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      // The canonical door the chat uses for `/browser <url>` and for the
      // agent's open_browser_pane: same event, same payload.
      await page.evaluate(
        ({ tid, u }) => {
          window.dispatchEvent(
            new CustomEvent("browser:open-and-navigate", { detail: { topicId: tid, url: u } }),
          );
        },
        { tid: topic.id, u: loopbackUrl },
      );
      await expect(page.locator("[data-browser-pane]").first()).toBeVisible({ timeout: 15_000 });

      // WHAT THE PANE ENDED UP SHOWING, in one word, so a failure names it
      // instead of reporting a bare `false`. Three outcomes are acceptable and
      // one is not: `new-tab` is the defect — the pane forgot the URL it was
      // opened on.
      const surface = async (): Promise<string> =>
        page.evaluate(() => {
          const has = (id: string): boolean => !!document.querySelector(`[data-testid="${id}"]`);
          if (has("browser-dom-cobrowse")) return "dom";
          if (has("browser-webrtc-video")) return "video";
          if (has("browser-nav-error") || has("browser-loopback-down")) return "error";
          if (has("browser-new-tab")) return "new-tab";
          return "none";
        });

      // AND "error" IS NOT AN ACCEPTED OUTCOME HERE.
      //
      // The strip that names a dead port is the right answer to a dead port,
      // and this test's port is alive by construction: the server serving it is
      // started by this file and is still running. So "gave up, explained why"
      // would be exactly the failure the card is about, wearing an excuse.
      // Only a navigation passes.
      await expect
        .poll(surface, { timeout: 90_000, message: "the pane never left the new-tab page" })
        .toMatch(/^(dom|video)$/);

      // No iframe, ever: the probe said non-framable and that verdict stands.
      await expect(page.locator('[data-testid="browser-iframe"]')).toHaveCount(0);

      // THE PROOF THAT THE PAGE WAS REALLY FETCHED, and not merely that some
      // surface replaced the new tab. Two independent witnesses, either of
      // which is conclusive, because they say the same thing by different
      // routes:
      //   - the server-side context reports the loopback url, or
      //   - the mirrored DOM contains the marker only this test's server serves.
      // It accepts EITHER rather than insisting on the first because the id the
      // service files the context under is not always the pane's id, and that
      // lookup answered 404 for a context that had demonstrably navigated. A
      // proof that depends on guessing the filing key is not a stronger proof,
      // only a flakier one. What neither witness can be produced by is the
      // failure this card is about: a pane sitting on the new tab, or a strip
      // apologising for not having tried.
      const host = new URL(loopbackUrl).host;
      const navigated = async (): Promise<boolean> => {
        const paneContextId = await page
          .locator("[data-browser-pane]")
          .first()
          .getAttribute("data-browser-pane");
        if (paneContextId) {
          const res = await request.get(`/api/browsers/${encodeURIComponent(paneContextId)}`);
          if (res.ok() && (((await res.json()) as { url?: string }).url ?? "").includes(host)) {
            return true;
          }
        }
        return await page
          .frameLocator("[data-browser-pane] iframe")
          .locator("#marker")
          .isVisible()
          .catch(() => false);
      };
      await expect
        .poll(navigated, {
          timeout: 90_000,
          message: "neither the server context nor the mirrored DOM ever showed the loopback page",
        })
        .toBe(true);

      const ended = await surface();
      if (ended === "dom") {
        // Co-browse mirrors the real DOM into the pane, so the marker - text
        // only THIS test's server can have produced - is the end-to-end proof
        // that the page was fetched, not merely that a surface appeared.
        //
        // Reached through the MIRROR IFRAME, because that is where rrweb
        // rebuilds the page (DomCoBrowse: "a same-origin iframe"). Asserting on
        // the pane's own innerText read "" forever and looked like a missing
        // page while the page was there, one document down.
        // Generous, because what is slow here is the replayer painting, and
        // under fleet load the pane legitimately reads "starting shared
        // session" for a while first.
        await expect(
          page.frameLocator("[data-browser-pane] iframe").locator("#marker"),
        ).toHaveText(PAGE_MARKER, { timeout: 90_000 });
      } else {
        // Screencast: the page is pixels, so there is no text to match. What is
        // assertable is that the pane is showing a live stream rather than the
        // new tab, which is exactly the line this card draws.
        await expect(page.locator('[data-testid="browser-webrtc-video"]')).toBeVisible({
          timeout: 30_000,
        });
      }
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });
});
