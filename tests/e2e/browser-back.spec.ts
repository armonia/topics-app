/**
 * browser-back.spec.ts: the ‹ of a browser tab takes the PAGE back.
 *
 * Reported on 2026-10-04: «l'indietro sembra non funzionale». On the web pane
 * whose site can be framed, the page lives in a hosted `<iframe>` that is built
 * once and never moved (`hostedIframe`). The frame's `src` was written only at
 * creation, so every later address the pane reached - a new address typed in
 * the sheet, the ‹ and the › - changed the tab's label and nothing else: the
 * frame kept showing the first page.
 *
 * The server-side browser is the one boundary mocked here (its socket and its
 * `interact` route, with a three-line history): what is under test is the
 * client turning the address it is told into the page it shows. The pages in
 * the frame are real, served by a local site.
 *
 * Runs on WebKit, the engine the product ships.
 */
import { test, expect, type Page, type WebSocketRoute } from "@playwright/test";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { goToApp } from "./helpers";
import {
  createTopic,
  deleteTopic,
  waitForTopicVisible,
  resetPaneStore,
  closeAllBrowserContexts,
} from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const HOST = "127.0.0.1";

/** A page that says which one it is, big enough to read in the clip. */
function pageNamed(name: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${name}</title>
<style>html,body{height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;
background:#0f1720;color:#e8eef5;font:600 48px system-ui,sans-serif}</style></head>
<body><h1 data-page="${name}">${name}</h1></body></html>`;
}

async function startSite(): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    const name = (req.url ?? "/").replace(/^\//, "").split("?")[0] || "index";
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(pageNamed(name));
  });
  await new Promise<void>((ok) => server.listen(0, HOST, ok));
  return { server, origin: `http://${HOST}:${(server.address() as AddressInfo).port}` };
}

/**
 * The server-side browser, reduced to its history: a `nav` request over the
 * socket pushes an entry, `interact` back/forward moves the cursor, and every
 * move is answered the way the real server answers it (`nav` / `response`).
 */
async function mockServerBrowser(page: Page, framable = true): Promise<{ entries: string[]; at: () => number; asked: string[] }> {
  const entries: string[] = [];
  /** Every history move the client asked for, in order. */
  const asked: string[] = [];
  let index = -1;
  let socket: WebSocketRoute | null = null;
  const announce = () => {
    socket?.send(JSON.stringify({ type: "nav", phase: "response", url: entries[index] }));
  };
  await page.routeWebSocket(/\/ws\/browser\//, (ws) => {
    socket = ws;
    ws.onMessage((raw) => {
      let msg: { type?: string; url?: string; phase?: string; mode?: string } = {};
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.type === "nav" && msg.phase === "request" && msg.url) {
        // Asking again for the page already shown is a reload, not a new
        // entry: the mount and the sheet may both ask for the first page.
        if (entries[index] !== msg.url) {
          entries.splice(index + 1, entries.length, msg.url);
          index = entries.length - 1;
        }
        announce();
      }
      if (msg.type === "set_render") ws.send(JSON.stringify({ type: "render_mode", mode: "video" }));
    });
  });
  await page.route(/\/api\/browsers\/[^/]+\/interact$/, async (route) => {
    const body = route.request().postDataJSON() as { action?: string; url?: string };
    if (body.action) asked.push(body.action);
    if (body.action === "back" && index > 0) { index -= 1; announce(); }
    if (body.action === "forward" && index < entries.length - 1) { index += 1; announce(); }
    if (body.action === "navigate" && body.url) {
      entries.splice(index + 1, entries.length, body.url);
      index = entries.length - 1;
      announce();
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  // The probe refuses loopback addresses (an SSRF guard), so its one answer is
  // faked: `true` takes the web client's real iframe path, `false` the shared
  // (streamed) one. Registered last, so it wins over the broader routes above.
  await page.route(/\/api\/browsers\/framable/, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ framable }) }),
  );
  return { entries, at: () => index, asked };
}

async function mountPane(page: Page, topicId: string, url: string): Promise<void> {
  await page.evaluate(
    ({ tid, u }) => {
      window.dispatchEvent(new CustomEvent("browser:open-and-navigate", { detail: { topicId: tid, url: u } }));
    },
    { tid: topicId, u: url },
  );
  await expect(page.locator("[data-browser-pane]").first()).toBeVisible({ timeout: 60_000 });
}

/** The tab's sheet, driven the way a person does: the tab, then the field or a button. */
function sheetOf(page: Page) {
  const tab = page.locator('[data-pane-id^="browser:"]').first();
  const sheet = page.getByTestId("browser-tab-sheet");
  const address = page.getByTestId("browser-tab-address-input");
  const go = async (url: string) => {
    await tab.getByTestId("pane-tab-label").click();
    await expect(sheet).toBeVisible({ timeout: 10_000 });
    await address.fill(url);
    await address.press("Enter");
    await expect(sheet).toHaveCount(0);
  };
  const press = async (testId: "browser-tab-back" | "browser-tab-forward") => {
    await tab.getByTestId("pane-tab-label").click();
    await expect(sheet).toBeVisible({ timeout: 10_000 });
    await sheet.getByTestId(testId).click();
    await expect(sheet).toHaveCount(0);
  };
  return { tab, go, press };
}

test.describe("BROWSER-BACK-01: the ‹ of a browser tab takes the page back", () => {
  let site: { server: Server; origin: string } | null = null;
  let topicId = "";

  test.beforeAll(async () => {
    site = await startSite();
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId).catch(() => {});
    await closeAllBrowserContexts(request);
    site?.server.close();
  });

  test("BROWSER-BACK-01: a framed page follows the address, and ‹ and › move the page itself", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "BROWSER-BACK-01" });
    const origin = site!.origin;
    await resetPaneStore(request, []);
    const topic = await createTopic(request, `E2E-BROWSER-BACK-${Date.now()}`);
    topicId = topic.id;
    const server = await mockServerBrowser(page);

    await goToApp(page);
    await waitForTopicVisible(page, topic.id);
    await mountPane(page, topic.id, `${origin}/uno`);

    const { tab, go, press } = sheetOf(page);
    const frame = page.frameLocator('[data-testid="browser-iframe"]');
    const shown = frame.locator("h1");

    await go(`${origin}/uno`);
    await expect(shown, "the first page is in the frame").toHaveText("uno", { timeout: 30_000 });
    await expect.poll(() => server.at()).toBe(0);
    const first = server.at();

    // A SECOND ADDRESS REACHES THE FRAME. Before the fix the tab said «due»
    // and the frame still showed «uno».
    await go(`${origin}/due`);
    await expect.poll(() => server.at()).toBe(first + 1);
    await expect(shown, "the address typed in the sheet is the page shown").toHaveText("due", { timeout: 15_000 });

    // ‹ TAKES THE PAGE BACK, not only the label.
    await press("browser-tab-back");
    await expect.poll(() => server.at()).toBe(first);
    await expect(shown, "‹ shows the page before").toHaveText("uno", { timeout: 15_000 });

    // › TAKES IT FORWARD AGAIN.
    await press("browser-tab-forward");
    await expect.poll(() => server.at()).toBe(first + 1);
    await expect(shown, "› shows the page after").toHaveText("due", { timeout: 15_000 });

    // AND THE FRAME IS STILL THE SAME ONE: following the address is a
    // navigation of the frame, never a second frame stacked over the first.
    await expect(page.locator('[data-testid="browser-iframe"]')).toHaveCount(1);
  });
  test("BROWSER-BACK-01b: on a streamed page ‹ asks the shared browser to go back, and the tab follows", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "BROWSER-BACK-01" });
    const origin = site!.origin;
    await resetPaneStore(request, []);
    const topic = await createTopic(request, `E2E-BROWSER-BACK-STREAM-${Date.now()}`);
    topicId = topic.id;
    const server = await mockServerBrowser(page, false);

    await goToApp(page);
    await waitForTopicVisible(page, topic.id);
    await mountPane(page, topic.id, `${origin}/uno`);

    const { tab, go, press } = sheetOf(page);
    await go(`${origin}/uno`);
    await expect(tab, "the tab names the first page").toContainText("/uno", { timeout: 15_000 });
    await go(`${origin}/due`);
    await expect(tab, "the tab names the second page").toContainText("/due", { timeout: 15_000 });
    await expect.poll(() => server.at()).toBe(1);

    await press("browser-tab-back");
    await expect.poll(() => server.asked, { message: "the shared browser was asked to go back" }).toContain("back");
    await expect(tab, "the tab follows the shared browser back").toContainText("/uno", { timeout: 15_000 });
    // No frame on this path: the page is the stream of the shared browser.
    await expect(page.locator('[data-testid="browser-iframe"]')).toHaveCount(0);
  });
});
