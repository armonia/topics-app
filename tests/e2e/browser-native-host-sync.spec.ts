import { test, expect, type Page } from "@playwright/test";
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
 */
const RRWEB_EVENTS = JSON.parse(
  readFileSync(resolvePath(__dirname, "fixtures/rrweb-sample.json"), "utf-8"),
) as unknown[];

const HOST_URL = "https://example.com/hosted";

/** Open the fake host on `ctx` in `hostPage` and wait for the server's ack. */
async function startFakeHost(hostPage: Page, ctx: string): Promise<void> {
  await hostPage.goto(`${E2E_BASE}/api/version`);
  await hostPage.evaluate(
    async ({ ctx, events, url }) => {
      const w = window as unknown as { __host: { frames: { type?: string; action?: string; url?: string }[] } };
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
    },
    { ctx, events: RRWEB_EVENTS, url: HOST_URL },
  );
}

async function hostFrames(hostPage: Page): Promise<{ type?: string; action?: string; url?: string; payload?: { x?: number; y?: number } }[]> {
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
});
