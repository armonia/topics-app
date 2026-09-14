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
    // 120s and not 90s because this runs on a machine that also runs the fleet:
    // at 90s it went flaky (timeout on the first attempt, green on the retry)
    // with trace and video on, which the config itself prices at +10%. The
    // budget has to cover the slowest legitimate run, not the median one.
    test.setTimeout(120_000);

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

      await expect
        .poll(surface, { timeout: 60_000, message: "the pane never left the new-tab page" })
        .toMatch(/^(dom|video|error)$/);

      // No iframe, ever: the probe said non-framable and that verdict stands.
      await expect(page.locator('[data-testid="browser-iframe"]')).toHaveCount(0);

      const ended = await surface();
      if (ended === "error") {
        // The honest second outcome: the pane could not reach the port, and it
        // SAYS so. An empty strip would be the same silence in another shape.
        const text = await page
          .locator('[data-testid="browser-nav-error"], [data-testid="browser-loopback-down"]')
          .first()
          .innerText();
        expect(text.trim().length).toBeGreaterThan(0);
      } else {
        // THE SERVER'S OWN URL IS THE PROOF, not the pixels.
        //
        // The assertion that belongs here is "the navigation happened", and the
        // server-side context is where that fact lives: its url is the loopback
        // one only if the headless browser really went there. Asserting on the
        // pane's text instead would be asserting on the REPLAYER's speed - in
        // screencast mode the page is a video and the marker is never in the
        // DOM at all, and in co-browse mode under load the pane legitimately
        // reads "starting shared session" for a while. Both are the renderer
        // warming up, neither is this card's defect.
        await expect
          .poll(
            async () => {
              const res = await request.get(`/api/browsers/${topic.id}`);
              if (!res.ok()) return `HTTP ${res.status()}`;
              return ((await res.json()) as { url?: string }).url ?? "";
            },
            { timeout: 30_000, message: "the server context never reached the loopback url" },
          )
          .toBe(loopbackUrl);
      }
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
    }
  });
});
