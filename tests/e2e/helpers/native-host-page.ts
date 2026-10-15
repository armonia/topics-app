/**
 * The Mac's native pane, for e2e: the real host module (client/src/lib/nativeDomHost.ts)
 * driving a WebKit page through `evaluate` with the server's own rrweb recorder,
 * as the native pane does through `browser_eval_js`. Only that transport is the
 * test's, and it can be made late the way a busy Mac makes `browser_eval_js` late.
 */
import { expect, type Page } from "@playwright/test";
import WebSocket from "ws";
import { createNativeDomHost } from "../../../client/src/lib/nativeDomHost";
import { E2E_BASE } from "./test-server";

export interface NativeHostPage {
  page: Page;
  /** Where the page (or the element `sel`) is scrolled to. */
  scrollOf: (sel?: string) => Promise<number>;
  width: () => number;
  /** Every size the server asked the page to be laid out at; null is the pane's own. */
  views: ({ width: number; height: number } | null)[];
  /** Scroll inputs the server relayed, the calls that ran them, and the wheel events the page got. */
  scrolls: () => Promise<{ relayed: number; calls: number; wheels: number }>;
  inputs: () => { clicks: number };
  /** History actions the native host received from viewers. */
  navigations: () => { back: number; forward: number };
  status: () => { sharing: boolean; devices: number; kbps: number; delayMs: number; error?: string } | null;
  setSharing: (active: boolean) => void;
  /** Application pings answered so far: the server holds a pane to the 15 s rule only after one. */
  pongs: () => number;
  /** The page's JavaScript stops, the socket stays open: pings go unanswered (NATIVE-HOST-07). */
  freeze: () => void;
  close: () => void;
}

/** Host `html` on `ctx` at `size`, as the Mac's pane titled `title`. */
export async function hostNativePage(
  page: Page,
  ctx: string,
  html: string,
  opts: { size: { width: number; height: number }; title: string; latencyMs?: number; url?: string },
): Promise<NativeHostPage> {
  await page.setViewportSize(opts.size);
  if (opts.url) await page.goto(opts.url);
  await page.setContent(html);
  const ws = new WebSocket(`${E2E_BASE.replace(/^http/, "ws")}/ws/browser/${encodeURIComponent(ctx)}?executor=1`);
  const count = { relayed: 0, calls: 0, clicks: 0 };
  const navigations = { back: 0, forward: 0 };
  let status: { sharing: boolean; devices: number; kbps: number; delayMs: number; error?: string } | null = null;
  const views: NativeHostPage["views"] = [];
  let pongs = 0;
  let frozen = false;
  await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
  const host = createNativeDomHost({
    evalInPage: async (js) => {
      if (js.endsWith("})") && js.includes('("scroll",')) count.calls++;
      if (opts.latencyMs) await new Promise((r) => setTimeout(r, opts.latencyMs));
      return page.evaluate((code) => String((0, eval)(code)), js);
    },
    loadRecorder: async () => (await fetch(`${E2E_BASE}/api/browser/recorder.js`)).text(),
    sendText: (text) => ws.send(text),
    navigate: () => {},
    setViewport: (size) => {
      views.push(size);
      void page.setViewportSize(size ?? opts.size);
    },
    onStatus: (next) => { status = next; },
  });
  ws.on("message", (data) => {
    const frame = JSON.parse(String(data)) as { type?: string; action?: string };
    // The native pane answers from its page's JavaScript (nativeExecutorSocket.ts);
    // the protocol ping is answered by the socket library, frozen or not.
    if (frame.type === "host_ping") {
      if (!frozen) { pongs++; ws.send(JSON.stringify({ type: "host_pong" })); }
      return;
    }
    if (frozen) return;
    if (frame.type === "native_host_status") status = frame as typeof status;
    if (frame.type === "host_input" && frame.action === "scroll") count.relayed++;
    if (frame.type === "host_input" && frame.action === "click") count.clicks++;
    if (frame.type === "host_input" && (frame.action === "back" || frame.action === "forward")) navigations[frame.action]++;
    host.handle(frame);
  });
  ws.send(JSON.stringify({ type: "register_native_executor" }));
  host.declare();
  await expect.poll(() => host.accepted()).toBe(true);
  host.notePage({ url: opts.url ?? "https://example.com/hosted", title: opts.title });
  return {
    page,
    scrollOf: (sel) => page.evaluate((s) => (s ? document.querySelector(s)!.scrollTop : scrollY), sel),
    width: () => page.viewportSize()?.width ?? 0,
    views,
    navigations: () => ({ ...navigations }),
    status: () => status,
    setSharing: (active) => ws.send(JSON.stringify({ type: "set_native_host_sharing", active })),
    pongs: () => pongs,
    freeze: () => { frozen = true; },
    scrolls: async () => ({ ...count, wheels: await page.evaluate(() => (window as unknown as { __wheels?: number }).__wheels ?? 0) }),
    inputs: () => ({ clicks: count.clicks }),
    close: () => { host.reset(); ws.close(); },
  };
}

/**
 * This device shows a page the Mac hosts the way it did before 14/10: the
 * Mac's page takes its size while it uses it (TOPIC-BROWSER-05), the choice a
 * device can still make (client/src/lib/browserLayoutPref.ts).
 */
export async function pageLayout(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem("topics-browser-layout", "page"));
}
