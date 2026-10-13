import { test, expect, type Frame, type Page } from "@playwright/test";
import { readFileSync } from "fs";
import { resolve as resolvePath } from "path";
import { goToApp } from "./helpers";
import { resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/**
 * The Mac's native pane hosts the mirror; the other device rebuilds THAT page.
 *
 * Before: a second device watching a context pulled the Mac off its WKWebView
 * onto the server's Chromium, and every gesture took the round trip ("lentissimo",
 * 13/10). Now the native pane records its own DOM and the server only relays it.
 *
 * The host here is a socket that speaks the native pane's protocol (register,
 * declare, answer `host_dom_start` with rrweb events), opened from a second page
 * of the test server; the viewer is the real web client. No Chromium is involved,
 * which is the point: the server must not launch one for a hosted context.
 *
 * @covers NATIVE-HOST-01
 * @covers NATIVE-HOST-02
 * @covers BROWSER-DOM-LIVE-01
 * @covers BROWSER-DOM-SCROLL-01
 */
const RRWEB_EVENTS = JSON.parse(
  readFileSync(resolvePath(__dirname, "fixtures/rrweb-sample.json"), "utf-8"),
) as unknown[];

const HOST_URL = "https://example.com/hosted";

/** A page five viewports tall, recorded a minute ago. */
function tallPage(stamp: number): unknown[] {
  return [
    { type: 4, timestamp: stamp, data: { href: "https://example.com/tall", width: 800, height: 600 } },
    { type: 2, timestamp: stamp + 1, data: { initialOffset: { left: 0, top: 0 }, node: { type: 0, id: 1, childNodes: [
      { type: 1, name: "html", publicId: "", systemId: "", id: 2 },
      { type: 2, tagName: "html", attributes: {}, id: 3, childNodes: [
        { type: 2, tagName: "head", attributes: {}, id: 4, childNodes: [] },
        { type: 2, tagName: "body", attributes: { style: "margin:0" }, id: 5, childNodes: [
          { type: 2, tagName: "div", attributes: { id: "tall", style: "position:relative;height:5000px" }, id: 6, childNodes: [
            { type: 3, textContent: "TALL", id: 7 },
          ] },
        ] },
      ] },
    ] } } },
  ];
}

/** Open the fake host on `ctx` in `hostPage` and wait for the server's ack. */
async function startFakeHost(hostPage: Page, ctx: string, events: unknown[] = RRWEB_EVENTS): Promise<void> {
  await hostPage.goto(`${E2E_BASE}/api/version`);
  await hostPage.evaluate(
    async ({ ctx, events, url }) => {
      const w = window as unknown as { __host: { frames: { type?: string; action?: string; url?: string }[]; ws?: WebSocket } };
      w.__host = { frames: [] };
      const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/ws/browser/${encodeURIComponent(ctx)}?executor=1`);
      const acked = new Promise<void>((res, rej) => {
        ws.addEventListener("message", (ev) => {
          const m = JSON.parse((ev as MessageEvent).data as string) as { type?: string };
          w.__host.frames.push(m);
          if (m.type === "native_dom_host_ack") {
            ws.send(JSON.stringify({ type: "host_page", url, title: "Hosted" }));
            res();
          }
          // What the native pane does on a start: arm rrweb, drain Meta + FullSnapshot.
          if (m.type === "host_dom_start") ws.send(JSON.stringify({ type: "host_dom_events", events }));
        });
        ws.addEventListener("error", () => rej(new Error("host socket error")));
      });
      await new Promise<void>((res) => ws.addEventListener("open", () => res()));
      ws.send(JSON.stringify({ type: "register_native_executor" }));
      ws.send(JSON.stringify({ type: "native_dom_host" }));
      await acked;
      w.__host.ws = ws;
    },
    { ctx, events, url: HOST_URL },
  );
}

/** A frame from the fake host, as the native pane would drain it. */
async function hostSend(hostPage: Page, frame: unknown): Promise<void> {
  await hostPage.evaluate((f) => (window as unknown as { __host: { ws: WebSocket } }).__host.ws.send(JSON.stringify(f)), frame);
}

/** The document the viewer rebuilt: rrweb's iframe inside the mirror. */
async function mirrorFrame(page: Page): Promise<Frame> {
  const handle = await page.locator('[data-testid="browser-dom-cobrowse"] iframe').first().elementHandle();
  const frame = await handle?.contentFrame();
  if (!frame) throw new Error("no mirror iframe");
  return frame;
}

async function hostFrames(hostPage: Page): Promise<{ type?: string; action?: string; url?: string; payload?: { x?: number; y?: number; deltaY?: number } }[]> {
  return hostPage.evaluate(() => (window as unknown as { __host: { frames: [] } }).__host.frames);
}

test.describe("Native pane as the mirror host", () => {
  test("the web viewer rebuilds the Mac's page, and its click reaches the Mac once", async ({ page, context, request }) => {
    const ctx = `e2e-host-${Date.now()}`;
    const hostPage = await context.newPage();
    await startFakeHost(hostPage, ctx);

    await resetPaneStore(request, [`browser:${ctx}`]);
    await goToApp(page);

    // The page the viewer shows is the host's: its DOM, and its address.
    const dom = page.locator('[data-testid="browser-dom-cobrowse"]').first();
    await expect(dom.frameLocator("iframe").locator("#hi")).toHaveText("DOM COBROWSE OK", { timeout: 10_000 });
    await expect.poll(async () => (await request.get(`${E2E_BASE}/api/browsers/${ctx}`)).json()).toMatchObject({ url: HOST_URL });

    const overlay = page.locator('[data-testid="browser-dom-input-overlay"]').first();
    const box = await overlay.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click(box!.x + 40, box!.y + 30);
    // An ordering barrier, not a sleep: the socket is ordered, so once the
    // scroll reached the host, every click before it has too.
    await page.mouse.move(box!.x + 60, box!.y + 60);
    await page.mouse.wheel(0, 40);
    await expect.poll(async () => (await hostFrames(hostPage)).some((f) => f.type === "host_input" && f.action === "scroll"), { timeout: 5_000 }).toBe(true);
    const clicks = (await hostFrames(hostPage)).filter((f) => f.type === "host_input" && f.action === "click");
    expect(clicks, JSON.stringify(clicks)).toHaveLength(1);

    // The server never opened a Chromium context for a hosted page.
    const status = (await (await request.get(`${E2E_BASE}/api/browser/status`)).json()) as { details?: { id?: string }[] };
    expect((status.details ?? []).map((d) => d.id)).not.toContain(ctx);

    await hostPage.close();
  });

  // Before: the replayer scheduled every event against the FIRST one's
  // timestamp, so whatever that one took to arrive (a 1 MB snapshot from the
  // Mac, or a buffered one minutes old) was added to every tap after it.
  test("a live change reaches the mirror at once, however old the snapshot it was rebuilt from", async ({ page, context, request }) => {
    const ctx = `e2e-host-live-${Date.now()}`;
    const hostPage = await context.newPage();
    await startFakeHost(hostPage, ctx);
    await resetPaneStore(request, [`browser:${ctx}`]);
    await goToApp(page);
    const hi = page.locator('[data-testid="browser-dom-cobrowse"]').first().frameLocator("iframe").locator("#hi");
    await expect(hi).toHaveText("DOM COBROWSE OK", { timeout: 10_000 });

    // The fixture was recorded in July; this change is recorded now.
    await hostSend(hostPage, { type: "host_dom_events", events: [
      { type: 3, timestamp: Date.now(), data: { source: 0, texts: [{ id: 18, value: "LIVE UPDATE" }], attributes: [], removes: [], adds: [] } },
    ] });
    await expect(hi).toHaveText("LIVE UPDATE", { timeout: 1_500 });
    await hostPage.close();
  });

  // Before: the mirror moved only when the Mac's own scroll came back, sampled
  // every 100ms and animated: a gesture on the iPad trailed by a third of a second.
  test("a scroll moves the mirror at once, and the source follows by the same distance", async ({ page, context, request }) => {
    const ctx = `e2e-host-scroll-${Date.now()}`;
    const hostPage = await context.newPage();
    await startFakeHost(hostPage, ctx, tallPage(Date.now() - 60_000));
    await resetPaneStore(request, [`browser:${ctx}`]);
    await goToApp(page);
    await expect(page.locator('[data-testid="browser-dom-cobrowse"]').first().frameLocator("iframe").locator("#tall")).toContainText("TALL", { timeout: 10_000 });

    const box = await page.locator('[data-testid="browser-dom-input-overlay"]').first().boundingBox();
    expect(box).not.toBeNull();
    const scale = box!.width / 800;
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.wheel(0, 300);

    // The fake host never answers with a scroll: whatever moved the mirror was local.
    const frame = await mirrorFrame(page);
    const scrolled = () => frame.evaluate(() => document.scrollingElement?.scrollTop ?? 0);
    await expect.poll(scrolled, { timeout: 500 }).toBeGreaterThan(0);
    // WebKit keeps whole pixels: the mirror lands within one of the distance asked.
    const local = await scrolled();
    expect(Math.abs(local - 300 / scale)).toBeLessThan(1.5);

    const relayed = async () => (await hostFrames(hostPage))
      .filter((f) => f.type === "host_input" && f.action === "scroll")
      .reduce((sum, f) => sum + (f.payload?.deltaY ?? 0), 0);
    await expect.poll(async () => Math.abs((await relayed()) - local), { timeout: 2_000 }).toBeLessThan(1.5);
    await hostPage.close();
  });
});
