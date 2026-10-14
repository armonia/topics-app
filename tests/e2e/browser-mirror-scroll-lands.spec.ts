import { test, expect, type Page } from "@playwright/test";
import WebSocket from "ws";
import { createNativeDomHost } from "../../client/src/lib/nativeDomHost";
import { goToApp } from "./helpers";
import { resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/**
 * A scroll made on the mirror lands on the same pixel of the page, and the
 * mirror stays where the finger left it.
 *
 * Before (14/10, from the iPad: "I scroll, and then it moves back by itself"):
 * the mirror and the Mac each replayed the distance. WebKit keeps whole pixels
 * and dropped the fractions on both sides at different cadences, once a frame
 * here and once a 60 ms batch there, so 600 ms after the gesture the mirror
 * jumped to wherever the Mac had got: 31 px on a 162 px swipe. A page with
 * `scroll-behavior: smooth` fell short on the Mac (50 px), and a Mac slower
 * than the relay replayed the swipe batch by batch: the mirror went back and
 * scrolled it again.
 *
 * The host is the real one: lib/nativeDomHost.ts drives a WebKit page through
 * `evaluate` with the server's own rrweb recorder, as the native pane does
 * through `browser_eval_js`. Only that transport is the test's.
 *
 * @covers BROWSER-DOM-SCROLL-01
 * @covers BROWSER-DOM-SCROLL-02
 */

const HOST_SIZE = { width: 1000, height: 700 };
/** The mirror holds the page's echoes this long after its last move (DomCoBrowse). */
const HOLD_MS = 600;

const ROWS = Array.from({ length: 300 }, (_, i) => `<p style="margin:0;height:40px;border-bottom:1px solid #ccc">Row ${i}</p>`).join("");

function pageHtml(opts: { smooth?: boolean; keepsWheel?: boolean; inner?: boolean } = {}): string {
  const html = opts.smooth ? '<html style="scroll-behavior:smooth">' : "<html>";
  const body = opts.inner
    ? `<div id="inner" style="height:500px;overflow:auto">${ROWS}</div>`
    : ROWS;
  // A map, a carousel: a page that turns the wheel into something of its own.
  const keeps = opts.keepsWheel ? "addEventListener('wheel',function(e){e.preventDefault()},{passive:false});" : "";
  const script = `<script>window.__wheels=0;addEventListener('wheel',function(){__wheels++},{passive:true});${keeps}</script>`;
  return `<!doctype html>${html}<head><meta charset="utf-8"><title>Scroll host</title>${script}</head><body style="margin:0;font:16px sans-serif">${body}</body></html>`;
}

/**
 * The native pane's half on `ctx`: the real host module over a socket of its
 * own, the page reached through `evaluate`, `latencyMs` added to every call
 * the way a busy Mac adds it to `browser_eval_js`.
 */
interface Host {
  scrollOf: (sel?: string) => Promise<number>;
  width: () => number;
  /** Scroll inputs the server relayed, the calls that ran them, and the wheel events the page got. */
  scrolls: () => Promise<{ relayed: number; calls: number; wheels: number }>;
  close: () => void;
}

async function hostPage(page: Page, ctx: string, html: string, latencyMs = 0): Promise<Host> {
  await page.setViewportSize(HOST_SIZE);
  await page.setContent(html);
  const ws = new WebSocket(`${E2E_BASE.replace(/^http/, "ws")}/ws/browser/${encodeURIComponent(ctx)}?executor=1`);
  const count = { relayed: 0, calls: 0 };
  await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
  const host = createNativeDomHost({
    evalInPage: async (js) => {
      if (js.endsWith("})") && js.includes('("scroll",')) count.calls++;
      if (latencyMs) await new Promise((r) => setTimeout(r, latencyMs));
      return page.evaluate((code) => String((0, eval)(code)), js);
    },
    loadRecorder: async () => (await fetch(`${E2E_BASE}/api/browser/recorder.js`)).text(),
    sendText: (text) => ws.send(text),
    navigate: () => {},
    setViewport: (size) => { void page.setViewportSize(size ?? HOST_SIZE); },
  });
  ws.on("message", (data) => {
    const frame = JSON.parse(String(data)) as { type?: string; action?: string };
    if (frame.type === "host_input" && frame.action === "scroll") count.relayed++;
    host.handle(frame);
  });
  ws.send(JSON.stringify({ type: "register_native_executor" }));
  host.declare();
  await expect.poll(() => host.accepted()).toBe(true);
  host.notePage({ url: "https://example.com/rows", title: "Scroll host" });
  return {
    scrollOf: (sel) => page.evaluate((s) => (s ? document.querySelector(s)!.scrollTop : scrollY), sel),
    width: () => page.viewportSize()?.width ?? 0,
    scrolls: async () => ({ ...count, wheels: await page.evaluate(() => (window as unknown as { __wheels: number }).__wheels) }),
    close: () => { host.reset(); ws.close(); },
  };
}

/**
 * Open the viewer on `ctx`, then make it the device using the page with a tap
 * outside it (TOPIC-BROWSER-05): the page is laid out at the pane's size and
 * shown 1:1, as on an iPad that is scrolling it. The first relayed scroll
 * would claim it anyway, halfway through the swipe.
 */
async function openMirror(page: Page, request: Parameters<typeof resetPaneStore>[0], ctx: string, host: { width: () => number }): Promise<void> {
  await resetPaneStore(request, [`browser:${ctx}`]);
  await goToApp(page);
  await expect(page.locator('[data-testid="browser-dom-cobrowse"]').first().frameLocator("iframe").getByText("Row 0", { exact: true })).toBeVisible({ timeout: 15_000 });
  await page.getByText("Scroll host").first().click();
  const overlay = page.locator('[data-testid="browser-dom-input-overlay"]').first();
  await expect.poll(async () => {
    const box = await overlay.boundingBox();
    return host.width() !== HOST_SIZE.width && !!box && Math.abs(box.width - host.width()) < 1;
  }).toBe(true);
}

interface Swipe {
  /** Where the mirror was when the gesture (and its fling) stopped. */
  atEnd: number;
  /** Every position the mirror took after that, through the hold and past it. */
  after: number[];
}

/**
 * Scroll the mirror from its overlay and watch it through the hold. `finger`
 * swipes with touches, which then fling; otherwise a trackpad's wheel. React
 * reads the coordinates off any event named like a touch, and WebKit on the
 * desktop does not construct real ones.
 */
async function swipe(page: Page, opts: { finger?: boolean; step: number; steps: number; inner?: boolean }): Promise<Swipe> {
  return page.evaluate(async ({ finger, step, steps, inner, holdMs }) => {
    const overlay = document.querySelector('[data-testid="browser-dom-input-overlay"]') as HTMLElement;
    const doc = (document.querySelector('[data-testid="browser-dom-cobrowse"] iframe') as HTMLIFrameElement).contentDocument!;
    const read = () => (inner ? doc.getElementById("inner")!.scrollTop : doc.scrollingElement!.scrollTop);
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    const box = overlay.getBoundingClientRect();
    const x = box.left + box.width / 2;
    // A finger starts low and goes up; a wheel turns over the top of the page.
    let y = box.top + box.height * (finger ? 0.8 : 0.3);
    const touch = (type: string) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      const list = [{ identifier: 1, clientX: x, clientY: y }];
      Object.defineProperty(event, "touches", { value: type === "touchend" ? [] : list });
      Object.defineProperty(event, "changedTouches", { value: list });
      overlay.dispatchEvent(event);
    };
    if (finger) touch("touchstart");
    for (let i = 0; i < steps; i++) {
      if (finger) {
        y -= step;
        touch("touchmove");
      } else {
        overlay.dispatchEvent(new WheelEvent("wheel", { deltaY: step, clientX: x, clientY: y, bubbles: true, cancelable: true }));
      }
      await frame();
    }
    if (finger) touch("touchend");
    // A fling goes on after the finger: the gesture is over when the mirror is still.
    let last = read();
    for (let still = 0; still < 10; ) {
      await frame();
      const now = read();
      still = now === last ? still + 1 : 0;
      last = now;
    }
    const atEnd = read();
    // What the hold releases cannot be waited for, only watched: through it and
    // as long again, every position the mirror takes is recorded.
    const after: number[] = [];
    const until = performance.now() + holdMs * 2 + 400;
    while (performance.now() < until) {
      await frame();
      const now = read();
      if (now !== (after.at(-1) ?? atEnd)) after.push(now);
    }
    return { atEnd, after };
  }, { finger: opts.finger ?? false, step: opts.step, steps: opts.steps, inner: opts.inner ?? false, holdMs: HOLD_MS });
}

test.describe("A scroll on the mirror lands where the finger left it", () => {
  test("a trackpad's swipe ends on the page's pixel, and the mirror stays put", async ({ page, context, request }) => {
    const ctx = `e2e-scroll-lands-${Date.now()}`;
    const host = await hostPage(await context.newPage(), ctx, pageHtml());
    await openMirror(page, request, ctx, host);

    // 2.7 px a frame: every frame has a fraction to lose.
    const { atEnd, after } = await swipe(page, { step: 2.7, steps: 60 });
    // Shown 1:1: the mirror went the whole 162 px, fractions included.
    expect(Math.abs(atEnd - 2.7 * 60)).toBeLessThanOrEqual(1);
    expect(after, "the mirror moved after the gesture").toEqual([]);
    await expect.poll(() => host.scrollOf()).toBe(atEnd);
    host.close();
  });

  test("a finger's swipe and its fling, on a smooth-scrolling page and a Mac that answers late", async ({ page, context, request }) => {
    const ctx = `e2e-scroll-lands-fling-${Date.now()}`;
    const host = await hostPage(await context.newPage(), ctx, pageHtml({ smooth: true }), 150);
    await openMirror(page, request, ctx, host);

    const { atEnd, after } = await swipe(page, { finger: true, step: 7.3, steps: 30 });
    // The fling carried it past the finger's own 219 px.
    expect(atEnd).toBeGreaterThan(219);
    expect(after, "the mirror moved after the gesture").toEqual([]);
    await expect.poll(() => host.scrollOf()).toBe(atEnd);
    // The Mac caught up in fewer calls than inputs, and the page still got every wheel.
    const { relayed, calls, wheels } = await host.scrolls();
    expect(calls).toBeLessThan(relayed);
    expect(wheels).toBe(relayed);
    host.close();
  });

  test("a page that keeps the wheel for itself brings the mirror back to where it is", async ({ page, context, request }) => {
    const ctx = `e2e-scroll-lands-kept-${Date.now()}`;
    const host = await hostPage(await context.newPage(), ctx, pageHtml({ keepsWheel: true }));
    await openMirror(page, request, ctx, host);

    const { atEnd } = await swipe(page, { step: 10, steps: 20 });
    expect(atEnd).toBeGreaterThan(0);
    // The page never moved, and says so: the mirror goes back to it.
    const frame = await (await page.locator('[data-testid="browser-dom-cobrowse"] iframe').first().elementHandle())!.contentFrame();
    await expect.poll(() => frame!.evaluate(() => document.scrollingElement!.scrollTop), { timeout: 5_000 }).toBe(0);
    expect(await host.scrollOf()).toBe(0);
    host.close();
  });

  test("an element that scrolls inside the page lands on the same pixel too", async ({ page, context, request }) => {
    const ctx = `e2e-scroll-lands-inner-${Date.now()}`;
    const host = await hostPage(await context.newPage(), ctx, pageHtml({ inner: true }));
    await openMirror(page, request, ctx, host);

    const { atEnd, after } = await swipe(page, { step: 2.7, steps: 60, inner: true });
    expect(atEnd).toBeGreaterThan(100);
    expect(after, "the mirror moved after the gesture").toEqual([]);
    await expect.poll(() => host.scrollOf("#inner")).toBe(atEnd);
    expect(await host.scrollOf()).toBe(0);
    host.close();
  });
});
