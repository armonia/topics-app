/**
 * WITHOUT THE HUB, NO TRACE (HUBBR-04).
 *
 * The small System pane and the status strip at the foot of the sidebar are
 * retired: what they showed moves to the places of the hub-smistamento change.
 * So with the hub absent, and with the hub down after it answered once, the
 * sidebar is the plain Topics sidebar, the palette has no «Sistema» entry, and
 * the console holds no error. The phone, at 390 px, has nothing above the
 * bottom row either.
 *
 * The hub is a fake (helpers/fake-hub.ts) on the port the test server is told
 * to read (`TOPICS_HUB_URL`): when it is not started nobody answers there, which
 * is the installation without the hub. The real :3360 is never touched. Video
 * on: the recording is the proof.
 *
 * @covers HUBBR-04
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { goToApp, openTestChat } from "./helpers";
import { startFakeHub } from "./helpers/fake-hub";
import { E2E_BASE } from "./helpers/test-server";

hermetic(test);
test.use({ video: "on" });
test.describe.configure({ mode: "serial", timeout: 120_000 });

// The words the retired surfaces used to say: none of them may be on screen.
const RETIRED_TEXT = /Tutto ok|Quasi tutto ok|Hub non raggiungibile|Hub raggiungibile in parte|Apri il pannello Sistema/;

/**
 * What the hub could leave in the console, from the first navigation on: every
 * uncaught page error, every console error that names the hub or the System
 * pane, and every request of the page to the hub's proxied routes
 * (`/api/hub/`, `/api/switchboard/`: with the strip gone only the open bell asks
 * them, so one on load is already a trace). Topics' own snapshot
 * `/api/hub-live`, which the bell's button reads, asks the hub nothing and may
 * pass. Console errors
 * of the engine itself stay out: WebKit on the PC logs its own viewport and
 * WebSocket-extension notices on every page, hub or not, and its
 * «ResizeObserver loop completed» reaches the page as an uncaught error: a
 * browser notice about layout, not an exception of the app.
 */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" && /hub|sistema|system/i.test(m.text())) errors.push(m.text()); });
  page.on("pageerror", (e) => { if (!e.message.startsWith("ResizeObserver loop")) errors.push(e.message); });
  page.on("request", (r) => { if (/^\/api\/(hub|switchboard)(\/|$)/.test(new URL(r.url()).pathname)) errors.push(`request ${r.url()}`); });
  return errors;
}

/** The live reader's snapshot: which topics read, which are in error. */
async function hubLive(request: APIRequestContext): Promise<Record<string, { data?: unknown; error?: string }>> {
  const resp = await request.get(`${E2E_BASE}/api/hub-live`);
  expect(resp.ok()).toBe(true);
  return (await resp.json()) as Record<string, { data?: unknown; error?: string }>;
}

async function expectNoHubTrace(page: Page) {
  await expect(page.getByTestId("system-strip")).toHaveCount(0);
  await expect(page.getByTestId("system-pane")).toHaveCount(0);
  await expect(page.getByTestId("pane-tab-__system__")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(RETIRED_TEXT);
}

async function expectNoPaletteEntry(page: Page) {
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByTestId("command-palette");
  await expect(palette).toBeVisible();
  await palette.getByRole("textbox").fill("Sistema");
  await expect(page.getByTestId("palette-system")).toHaveCount(0);
  await expect(palette).not.toContainText("agenti, allarmi e automazioni");
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
}

test.describe("Without the hub, no trace", () => {
  test("desktop, no hub: no strip, no palette entry, no console error", async ({ page, request }, testInfo) => {
    // The condition this test claims: nobody answers on the hub's address.
    const snap = await hubLive(request);
    expect(snap.pace?.data).toBeUndefined();
    expect(typeof snap.pace?.error).toBe("string");

    const errors = collectErrors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "dark" });
    await goToApp(page);
    await openTestChat(page);
    await expect(page.getByLabel("Topics sidebar")).toBeVisible();
    await expectNoHubTrace(page);
    // Automazioni is the hub's: without it, not even the row above the Board.
    await expect(page.getByTestId("sidebar-automations")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("vero-scuro.png") });

    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
    await page.screenshot({ path: testInfo.outputPath("vero-chiaro.png") });
    await page.emulateMedia({ colorScheme: "dark" });

    await expectNoPaletteEntry(page);
    expect(errors).toEqual([]);
  });

  test("desktop, hub up and then down: the sidebar stays the same, no console error", async ({ page, request }) => {
    const hub = await startFakeHub();
    try {
      // The hub answers: the reader holds its data.
      await expect.poll(async () => (await hubLive(request)).pace?.data !== undefined, { timeout: 20_000 }).toBe(true);
      const errors = collectErrors(page);
      await page.setViewportSize({ width: 1440, height: 900 });
      await goToApp(page);
      await openTestChat(page);
      await expectNoHubTrace(page);
      await expect(page.getByTestId("sidebar-automations")).toBeVisible();

      // The hub stops answering: the reader says so, and a reload shows the
      // same sidebar as before.
      await hub.close();
      await expect.poll(async () => typeof (await hubLive(request)).pace?.error, { timeout: 20_000 }).toBe("string");
      await page.reload();
      await expect(page.getByLabel("Topics sidebar")).toBeVisible({ timeout: 30_000 });
      await expectNoHubTrace(page);
      // A page loaded with the hub down has never read it: like every hub surface, no row.
      await expect(page.getByTestId("sidebar-automations")).toHaveCount(0);
      await expectNoPaletteEntry(page);
      expect(errors).toEqual([]);
    } finally {
      await hub.close().catch(() => {});
    }
  });

  test("phone, 390 px, no hub: nothing above the bottom row", async ({ browser }, testInfo) => {
    const ctx = await browser.newContext({
      baseURL: E2E_BASE, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: "dark",
      recordVideo: { dir: testInfo.outputPath("phone-video"), size: { width: 390, height: 844 } },
    });
    const page = await ctx.newPage();
    try {
      const errors = collectErrors(page);
      await page.goto("/");
      await expect(page.getByTestId("mobile-chrome-bar")).toBeVisible({ timeout: 30_000 });
      await expectNoHubTrace(page);
      await page.screenshot({ path: testInfo.outputPath("vero-telefono.png") });
      expect(errors).toEqual([]);
    } finally {
      await ctx.close();
    }
  });
});
