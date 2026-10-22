import { test, expect, type Frame, type Page } from "@playwright/test";
import { readFileSync } from "fs";
import { resolve as resolvePath } from "path";
import { goToApp } from "./helpers";
import { pageLayout } from "./helpers/native-host-page";
import { resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { hostEventFrames } from "../../shared/browser-ws-chunks";

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
 * @covers NATIVE-HOST-04
 * @covers NATIVE-HOST-05
 * @covers BROWSER-DOM-LIVE-01
 * @covers BROWSER-DOM-SCROLL-01
 * @covers BROWSER-DOM-LAZY-01
 * @covers BROWSER-DOM-IDLE-01
 */
const RRWEB_EVENTS = JSON.parse(
  readFileSync(resolvePath(__dirname, "fixtures/rrweb-sample.json"), "utf-8"),
) as unknown[];

const HOST_URL = "https://example.com/hosted";

/** A page five viewports tall, recorded a minute ago, holding `inside`. */
function tallPage(stamp: number, inside: unknown[] = []): unknown[] {
  return [
    { type: 4, timestamp: stamp, data: { href: "https://example.com/tall", width: 800, height: 600 } },
    { type: 2, timestamp: stamp + 1, data: { initialOffset: { left: 0, top: 0 }, node: { type: 0, id: 1, childNodes: [
      { type: 1, name: "html", publicId: "", systemId: "", id: 2 },
      { type: 2, tagName: "html", attributes: {}, id: 3, childNodes: [
        { type: 2, tagName: "head", attributes: {}, id: 4, childNodes: [] },
        { type: 2, tagName: "body", attributes: { style: "margin:0" }, id: 5, childNodes: [
          { type: 2, tagName: "div", attributes: { id: "tall", style: "position:relative;height:5000px" }, id: 6, childNodes: [
            { type: 3, textContent: "TALL", id: 7 },
            ...inside,
          ] },
        ] },
      ] },
    ] } } },
  ];
}

/** Open the fake host on `ctx` in `hostPage` and wait for the server's ack. */
async function startFakeHost(hostPage: Page, ctx: string, events: unknown[] = RRWEB_EVENTS): Promise<void> {
  // Cut the way the native pane cuts them, so a large page takes the same road as on the Mac.
  const initialFrames = hostEventFrames(events, `initial-${Date.now()}`);
  await hostPage.goto(`${E2E_BASE}/api/version`);
  await hostPage.evaluate(
    async ({ ctx, initialFrames, url }) => {
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
          if (m.type === "host_dom_start") for (const frame of initialFrames) ws.send(frame);
        });
        ws.addEventListener("error", () => rej(new Error("host socket error")));
      });
      await new Promise<void>((res) => ws.addEventListener("open", () => res()));
      ws.send(JSON.stringify({ type: "register_native_executor" }));
      ws.send(JSON.stringify({ type: "native_dom_host" }));
      await acked;
      w.__host.ws = ws;
    },
    { ctx, initialFrames, url: HOST_URL },
  );
}

/** A frame from the fake host, as the native pane would drain it. */
async function hostSend(hostPage: Page, frame: unknown): Promise<void> {
  const batch = frame as { type?: string; events?: unknown[] };
  const frames = batch.type === "host_dom_events" && Array.isArray(batch.events)
    ? hostEventFrames(batch.events, `host-${Date.now()}`)
    : [JSON.stringify(frame)];
  await hostPage.evaluate((items) => { const ws = (window as unknown as { __host: { ws: WebSocket } }).__host.ws; for (const item of items) ws.send(item); }, frames);
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
  test("a 3 MB FullSnapshot reaches the viewer without closing either socket", async ({ page, context, request }) => {
    const ctx = `e2e-host-large-${Date.now()}`;
    const hostPage = await context.newPage();
    const largeText = "x".repeat(3_000_000) + "END";
    const events = [
      { type: 4, timestamp: 1, data: { href: HOST_URL, width: 800, height: 600 } },
      { type: 2, timestamp: 2, data: { node: { type: 0, id: 1, childNodes: [
        { type: 1, name: "html", publicId: "", systemId: "", id: 2 },
        { type: 2, tagName: "html", attributes: {}, id: 3, childNodes: [
          { type: 2, tagName: "head", attributes: {}, id: 4, childNodes: [] },
          { type: 2, tagName: "body", attributes: {}, id: 5, childNodes: [
            { type: 2, tagName: "div", attributes: { id: "large-snapshot" }, id: 6, childNodes: [{ type: 3, textContent: largeText, id: 7 }] },
          ] },
        ] },
      ] } } },
    ];
    await startFakeHost(hostPage, ctx, events);
    await resetPaneStore(request, [`browser:${ctx}`]);
    await goToApp(page);
    const largeMirror = page.locator('[data-testid="browser-dom-cobrowse"] iframe').first().contentFrame().locator("#large-snapshot");
    await expect.poll(async () => (await largeMirror.textContent())?.length, { timeout: 15_000 }).toBe(3_000_003);
    await expect(largeMirror).toContainText("END");
    expect(await hostPage.evaluate(() => (window as unknown as { __host: { ws: WebSocket } }).__host.ws.readyState)).toBe(1);
    await hostPage.close();
  });

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
  // At the Mac's pixel, scaled: a distance here is the same distance there.
  test("a scroll moves the mirror at once, and the source follows by the same distance", async ({ page, context, request }) => {
    await pageLayout(page);
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

  // The source's answer to a scroll waits for the gesture to end, then wins: a
  // tap lands where the source is, so the mirror must show that, even when its
  // clock parked while the answer waited.
  test("after a scroll, the mirror settles where the source ended up", async ({ page, context, request }) => {
    const ctx = `e2e-host-settle-${Date.now()}`;
    const hostPage = await context.newPage();
    await startFakeHost(hostPage, ctx, tallPage(Date.now() - 60_000));
    await resetPaneStore(request, [`browser:${ctx}`]);
    await goToApp(page);
    await expect(page.locator('[data-testid="browser-dom-cobrowse"]').first().frameLocator("iframe").locator("#tall")).toContainText("TALL", { timeout: 10_000 });

    const box = await page.locator('[data-testid="browser-dom-input-overlay"]').first().boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.wheel(0, 300);
    const frame = await mirrorFrame(page);
    const scrolled = () => frame.evaluate(() => document.scrollingElement?.scrollTop ?? 0);
    await expect.poll(scrolled, { timeout: 500 }).toBeGreaterThan(0);

    // The source stopped short of the distance asked (a page can clamp it), and says so at once.
    await hostSend(hostPage, { type: "host_dom_events", events: [
      { type: 3, timestamp: Date.now(), data: { source: 3, id: 1, x: 0, y: 120 } },
    ] });
    await expect.poll(scrolled, { timeout: 3_000 }).toBe(120);
    await hostPage.close();
  });

  // Before: the mirror runs no scripts, which turns lazy loading off, so a
  // viewer fetched every image of the page as it opened it (568 on Darkroom, 13/10).
  test("a lazy image loads when the mirror comes near it, not before", async ({ page, context, request }) => {
    const ctx = `e2e-host-lazy-${Date.now()}`;
    const lazyImage = (id: number, name: string, top: number) => ({ type: 2, tagName: "img", id, childNodes: [],
      attributes: { src: `https://lazy.invalid/${name}.png`, loading: "lazy", style: `position:absolute;top:${top}px;width:100px;height:100px` } });
    const requested: string[] = [];
    page.on("request", (r) => requested.push(r.url()));
    const hostPage = await context.newPage();
    await startFakeHost(hostPage, ctx, tallPage(Date.now() - 60_000, [lazyImage(8, "near", 100), lazyImage(9, "far", 4000)]));
    await resetPaneStore(request, [`browser:${ctx}`]);
    await goToApp(page);
    const tall = page.locator('[data-testid="browser-dom-cobrowse"]').first().frameLocator("iframe").locator("#tall");
    await expect(tall).toContainText("TALL", { timeout: 10_000 });

    await expect.poll(() => requested.some((u) => u.includes("near.png")), { timeout: 5_000 }).toBe(true);
    // A change applied after the rebuild: by then an eager image would have been fetched too.
    await hostSend(hostPage, { type: "host_dom_events", events: [
      { type: 3, timestamp: Date.now(), data: { source: 0, texts: [{ id: 7, value: "SETTLED" }], attributes: [], removes: [], adds: [] } },
    ] });
    await expect(tall).toContainText("SETTLED", { timeout: 1_500 });
    expect(requested.filter((u) => u.includes("far.png"))).toEqual([]);

    const box = await page.locator('[data-testid="browser-dom-input-overlay"]').first().boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.wheel(0, 3900 * (box!.width / 800));
    await expect.poll(() => requested.some((u) => u.includes("far.png")), { timeout: 5_000 }).toBe(true);
    await hostPage.close();
  });

  // Before: rrweb's live clock asked for a frame on every frame, idle or not,
  // and the mirror's park could not stop it (60 a second in WebKit, 13/10).
  test("an idle mirror asks for no frames, and the next change still lands at once", async ({ page, context, request }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __frames: number };
      w.__frames = 0;
      const ask = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (callback) => { w.__frames++; return ask(callback); };
    });
    const ctx = `e2e-host-idle-${Date.now()}`;
    const hostPage = await context.newPage();
    await startFakeHost(hostPage, ctx, tallPage(Date.now() - 60_000));
    await resetPaneStore(request, [`browser:${ctx}`]);
    await goToApp(page);
    const tall = page.locator('[data-testid="browser-dom-cobrowse"]').first().frameLocator("iframe").locator("#tall");
    await expect(tall).toContainText("TALL", { timeout: 10_000 });

    // Frames the page asks for over `ms`, counted in the page.
    const framesAsked = (ms: number) => page.evaluate((ms) => new Promise<number>((resolve) => {
      const w = window as unknown as { __frames: number };
      const from = w.__frames;
      setTimeout(() => resolve(w.__frames - from), ms);
    }), ms);
    // The mirror parks 400ms after its last event, and stays parked.
    await expect.poll(() => framesAsked(250), { timeout: 3_000 }).toBeLessThan(3);
    expect(await framesAsked(2_000)).toBeLessThan(10);

    // Seconds after the first event: a clock restarted from zero would hold this back as long.
    await hostSend(hostPage, { type: "host_dom_events", events: [
      { type: 3, timestamp: Date.now(), data: { source: 0, texts: [{ id: 7, value: "WOKEN" }], attributes: [], removes: [], adds: [] } },
    ] });
    await expect(tall).toContainText("WOKEN", { timeout: 1_500 });
    await hostPage.close();
  });

  // Before: the iPad that used a page hosted by the Mac got the Mac's layout,
  // scaled down and letterboxed; its own size was dropped on the floor.
  // The choice a device can still make (BROWSER-DOM-LAYOUT-01): the Mac's page at its size while it uses it.
  test("the device using a hosted page gets it at its own size, 1:1, until the Mac uses it again", async ({ page, context, request }) => {
    await pageLayout(page);
    const ctx = `e2e-host-viewport-${Date.now()}`;
    const hostPage = await context.newPage();
    // The Mac lays the page out at its slot, larger than the viewer's pane.
    const stamp = Date.now() - 60_000;
    const macPage = [{ type: 4, timestamp: stamp, data: { href: HOST_URL, width: 1600, height: 1000 } }, ...tallPage(stamp).slice(1)];
    await startFakeHost(hostPage, ctx, macPage);
    await resetPaneStore(request, [`browser:${ctx}`]);
    await goToApp(page);
    const dom = page.locator('[data-testid="browser-dom-cobrowse"]').first();
    await expect(dom.frameLocator("iframe").locator("#tall")).toContainText("TALL", { timeout: 10_000 });

    const sizes = async () => (await hostFrames(hostPage) as { type?: string; width?: number; height?: number }[])
      .filter((f) => f.type === "host_viewport");
    const transform = () => dom.evaluate((el) => (el.querySelector(".replayer-wrapper") as HTMLElement | null)?.style.transform ?? "");
    const scaleOf = (t: string) => Number(/scale\(([\d.]+)\)/.exec(t)?.[1] ?? NaN);
    // Watching is not using: the host's layout stays the Mac's, and the mirror fits it.
    expect(await sizes()).toEqual([]);
    expect(scaleOf(await transform())).toBeLessThan(0.95);

    // A tap makes this device the one using the page: the host hears the tap,
    // then the size to lay the page out at, which is this pane's.
    const box = (await page.locator('[data-testid="browser-dom-input-overlay"]').first().boundingBox())!;
    await page.mouse.click(box.x + 40, box.y + 30);
    await expect.poll(async () => (await sizes()).length, { timeout: 5_000 }).toBe(1);
    const frames = await hostFrames(hostPage) as { type?: string; width?: number; height?: number }[];
    const own = (await sizes())[0];
    expect(frames.findIndex((f) => f.type === "host_input")).toBeLessThan(frames.findIndex((f) => f.type === "host_viewport"));
    const pane = await dom.evaluate((el) => ({ width: el.clientWidth, height: el.clientHeight }));
    expect(Math.abs(own.width! - pane.width)).toBeLessThanOrEqual(2);
    expect(Math.abs(own.height! - pane.height)).toBeLessThanOrEqual(2);

    // The Mac lays it out there, a pixel over from its page zoom's rounding:
    // the mirror shows it 1:1 from the top, not at 0.999 in a letterbox.
    await hostSend(hostPage, { type: "host_dom_events", events: [
      { type: 3, timestamp: Date.now(), data: { source: 4, width: own.width, height: own.height! + 1 } },
    ] });
    // WebKit writes a translate with no vertical part as `translate(Xpx)`.
    await expect.poll(transform, { timeout: 2_000 }).toMatch(/^translate\(\d+px(, 0px)?\) scale\(1\)$/);

    // The Mac's user touches its own pane: the page goes back to the Mac's slot.
    await hostSend(hostPage, { type: "host_local_use" });
    await expect.poll(async () => (await sizes()).length, { timeout: 5_000 }).toBe(2);
    expect((await sizes())[1]).toEqual({ type: "host_viewport" });
    await hostSend(hostPage, { type: "host_dom_events", events: [
      { type: 3, timestamp: Date.now(), data: { source: 4, width: 1600, height: 1000 } },
    ] });
    await expect.poll(async () => scaleOf(await transform()), { timeout: 2_000 }).toBeLessThan(0.95);

    // Used again, then gone: the page goes back to the Mac with it.
    await page.mouse.click(box.x + 40, box.y + 30);
    await expect.poll(async () => (await sizes()).length, { timeout: 5_000 }).toBe(3);
    await page.close();
    await expect.poll(async () => (await sizes()).at(-1), { timeout: 5_000 }).toEqual({ type: "host_viewport" });
    await hostPage.close();
  });

  // Before: opening the page on the iPad showed the Mac's layout until the first
  // touch ON the page (reported 14/10: the iPad got the Mac's resolution, not
  // its own). Using the device is using the page it shows.
  test("a tap anywhere on the device lays the page out at this pane's size, with no input to the page", async ({ page, context, request }) => {
    await pageLayout(page);
    const ctx = `e2e-host-device-use-${Date.now()}`;
    const hostPage = await context.newPage();
    const stamp = Date.now() - 60_000;
    const macPage = [{ type: 4, timestamp: stamp, data: { href: HOST_URL, width: 1600, height: 1000 } }, ...tallPage(stamp).slice(1)];
    await startFakeHost(hostPage, ctx, macPage);
    await resetPaneStore(request, [`browser:${ctx}`]);
    await goToApp(page);
    const dom = page.locator('[data-testid="browser-dom-cobrowse"]').first();
    await expect(dom.frameLocator("iframe").locator("#tall")).toContainText("TALL", { timeout: 10_000 });

    const sizes = async () => (await hostFrames(hostPage) as { type?: string; width?: number; height?: number }[])
      .filter((f) => f.type === "host_viewport");
    const transform = () => dom.evaluate((el) => (el.querySelector(".replayer-wrapper") as HTMLElement | null)?.style.transform ?? "");
    // Loaded with nobody touching anything: the page stays the Mac's.
    expect(await sizes()).toEqual([]);

    // A tap on the page's title in Topics, not on the page.
    await page.getByText("Hosted", { exact: true }).first().click();
    await expect.poll(async () => (await sizes()).length, { timeout: 5_000 }).toBe(1);
    const own = (await sizes())[0];
    const pane = await dom.evaluate((el) => ({ width: el.clientWidth, height: el.clientHeight }));
    expect(Math.abs(own.width! - pane.width)).toBeLessThanOrEqual(2);
    expect(Math.abs(own.height! - pane.height)).toBeLessThanOrEqual(2);
    expect((await hostFrames(hostPage)).filter((f) => f.type === "host_input"), "the tap reached the page").toEqual([]);

    // The Mac lays it out there, and this device sees it 1:1.
    await hostSend(hostPage, { type: "host_dom_events", events: [
      { type: 3, timestamp: Date.now(), data: { source: 4, width: own.width, height: own.height } },
    ] });
    await expect.poll(transform, { timeout: 2_000 }).toMatch(/^translate\(\d+px(, 0px)?\) scale\(1\)$/);
    await hostPage.close();
  });
});
