/**
 * THE MACHINE'S PROCESSES (hub-smistamento, HUBBR-08 and HUBBR-09).
 *
 * Sistema in the Topics menu opens «Processi»: the Mac with GPU and network
 * per process (a dash where the hub did not measure), the PC, the services and
 * the Claude proxy's log, live. The only Stop button is on a project script Topics
 * started: here a real script of a scratch project, whose pid the fake census
 * puts in the dev server's unit, so the stop is the real one. Closing the
 * view's tab closes the proxy's stream (the fake counts it). The gauges carry
 * the hub's 24 h history as a line; with the hub gone the view keeps its last
 * numbers under the hub-down band. The phone test runs first, while the script
 * is still running, so the 390 px shot shows its Stop row.
 *
 * The hub is a fake (helpers/fake-hub.ts) on the port the test server reads;
 * the real :3360 and :3335 are never touched, and the names are placeholders.
 *
 * Mutation: with `scriptForUnit` (lib/machineProcesses.ts) answering null, «only the script stops» is
 * red (no row carries a Stop button); with the EventSource left open on unmount,
 * «closed with the view» is red (the fake never sees the stream end).
 *
 * The shots are taken in the mockups' workspace (helpers/shot-scene.ts):
 * acme-web and studio-x with their chats in the sidebar, a chat with messages.
 *
 * Video on: the recording is the proof. The screenshots of the built surface go
 * to the test's output (`vero-processi-macchina-*.png`).
 *
 * @covers HUBBR-08
 * @covers HUBBR-09
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { resetPaneStore } from "./helpers/api-fixtures";
import { openMainChat, openSceneInSidebar, seedScene, type Scene } from "./helpers/shot-scene";
import { goToApp } from "./helpers";
import { openPerfPanel } from "./helpers/open-perf-panel";
import { startFakeHub, type FakeHub } from "./helpers/fake-hub";
import { E2E_BASE, canonicalTmpRoot } from "./helpers/test-server";

hermetic(test);
test.use({ video: "on" });
test.describe.configure({ mode: "serial", timeout: 150_000 });

const PANE = "machine-processes";

/** The reader holds the fake hub's services: the menu row exists. */
async function waitForHub(request: APIRequestContext): Promise<void> {
  await expect.poll(async () => {
    const snap = (await (await request.get(`${E2E_BASE}/api/hub-live`)).json()) as Record<string, { data?: { services?: unknown[] } }>;
    return snap.services?.data?.services?.length ?? -1;
  }, { timeout: 30_000, message: "the live reader never read the fake hub" }).toBeGreaterThan(0);
}

async function waitForHubDown(request: APIRequestContext): Promise<void> {
  await expect.poll(async () => {
    const snap = (await (await request.get(`${E2E_BASE}/api/hub-live`)).json()) as Record<string, { error?: string }>;
    return typeof snap.services?.error;
  }, { timeout: 30_000 }).toBe("string");
}

/** A real project script, long-lived, in a scratch project called acme-web. */
async function startScript(request: APIRequestContext): Promise<{ processId: string; pid: number; dir: string }> {
  const dir = join(mkdtempSync(join(tmpdir(), "topics-e2e-procs-")), "acme-web");
  mkdirSync(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "acme-web", private: true, scripts: { dev: "node -e \"setInterval(() => {}, 1000)\"" } }));
  const r = await request.post(`${E2E_BASE}/api/scripts/run`, { data: { projectPath: dir, scriptName: "dev", tty: false } });
  expect(r.ok(), await r.text()).toBeTruthy();
  const { processId, pid } = (await r.json()) as { processId: string; pid: number };
  return { processId, pid, dir };
}

async function openFromMenu(page: Page): Promise<void> {
  await openPerfPanel(page);
  await page.getByTestId("menu-system-processes").click();
  await expect(page.getByTestId(PANE)).toBeVisible({ timeout: 20_000 });
}

test.describe("the machine's processes", () => {
  let hub: FakeHub | null = null;
  let script: { processId: string; pid: number; dir: string } | null = null;
  let scene: Scene | null = null;

  test.beforeAll(async ({ request }) => {
    scene = await seedScene(request, `${canonicalTmpRoot()}/e2e-machine-processes-${Date.now().toString(36)}`);
    hub = await startFakeHub();
    await waitForHub(request);
    script = await startScript(request);
    hub.devPids = [script.pid];
  });
  test.afterAll(async ({ request }) => {
    if (script) await request.post(`${E2E_BASE}/api/scripts/${script.processId}/stop`).catch(() => {});
    await hub?.close();
    await waitForHubDown(request);
    await scene?.cleanup(request);
  });

  // Each test starts on the scene alone: a view opened by the test before
  // stays a tab, and clicking its row again would only focus that tab.
  test.beforeEach(async ({ request }) => {
    if (!scene) return;
    await resetPaneStore(request, []);
    await openSceneInSidebar(request, scene);
  });

  test("phone, 390 px: one column, the figures under each name, nothing wider than the screen", async ({ browser }, testInfo) => {
    const ctx = await browser.newContext({
      baseURL: E2E_BASE, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: "dark", locale: "it-IT",
      recordVideo: { dir: testInfo.outputPath("phone-video"), size: { width: 390, height: 844 } },
    });
    const page = await ctx.newPage();
    try {
      await page.goto("/");
      await expect(page.getByTestId("mobile-chrome-bar")).toBeVisible({ timeout: 30_000 });
      await expect.poll(() => page.evaluate(() => {
        window.dispatchEvent(new CustomEvent("topics:open-utility", { detail: { type: "processes" } }));
        return document.querySelector('[data-testid="machine-processes"]') !== null;
      }), { timeout: 20_000 }).toBe(true);
      const pane = page.getByTestId(PANE);
      await expect(pane.getByTestId("machine-process-row")).toHaveCount(8, { timeout: 20_000 });
      await expect(pane.getByTestId("machine-process-row").first()).toContainText("GPU");
      // The script's row at 390 px: its Stop button and the project › script link, in view for the shot.
      const dev = pane.getByTestId("machine-process-row").filter({ has: page.getByTestId("machine-process-stop") });
      await expect(dev).toHaveCount(1, { timeout: 20_000 });
      await expect(dev.getByTestId("machine-process-script")).toContainText("acme-web › dev");
      await dev.scrollIntoViewIfNeeded();
      const box = await dev.getByTestId("machine-process-stop").boundingBox();
      expect(box && box.x + box.width).toBeLessThanOrEqual(390);
      const widths = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth,
        pane: document.querySelector<HTMLElement>('[data-testid="machine-processes"]')!.scrollWidth,
      }));
      expect(widths.doc).toBeLessThanOrEqual(390);
      expect(widths.pane).toBeLessThanOrEqual(390);
      await page.screenshot({ path: testInfo.outputPath("vero-processi-macchina-telefono.png") });
    } finally {
      await ctx.close();
    }
  });

  test("Sistema opens Processi: GPU and network per process, a dash where not measured, Stop button only on the script; the log closes with the view", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.emulateMedia({ colorScheme: "dark" });
    await goToApp(page);
    await openMainChat(page, scene!);
    await openFromMenu(page);
    const pane = page.getByTestId(PANE);
    const rows = pane.getByTestId("machine-process-row");
    await expect(rows).toHaveCount(8, { timeout: 20_000 });

    // Measured rows show GPU and network; the system's row has no network and shows the dash.
    const topics = rows.filter({ has: page.getByText("Topics", { exact: true }) });
    await expect(topics.getByTestId("machine-process-gpu")).toHaveText("12%");
    await expect(topics.getByTestId("machine-process-net")).toContainText("120 KB/s");
    // One of Topics' two processes is measured: a floor, said as one.
    await expect(topics.getByTestId("machine-process-cpu")).toHaveText("≥18%");
    // A hog grouped by name under the browser's pid is not that pid's CPU.
    await expect(rows.filter({ has: page.getByText("Browser", { exact: true }) }).getByTestId("machine-process-cpu")).toHaveText("-");
    const system = rows.filter({ has: page.getByText("macOS", { exact: true }) });
    await expect(system.getByTestId("machine-process-net")).toHaveText("-");
    await expect(rows.filter({ hasText: "Container locali" }).getByTestId("machine-process-cpu")).toHaveText("-");
    await expect(pane.getByTestId("machine-processes-more")).toContainText("Altri 6 processi");

    // The day behind the gauges: a 24 h line on the Mac's CPU and GPU and on
    // the PC's four, with the peak in words. Not under the Mac's used GB: the
    // hub's memory history is the pressure, named in the section's head instead.
    await expect(pane.getByTestId("machine-processes-mac").getByTestId("machine-gauge-history")).toHaveCount(2);
    await expect(pane.getByTestId("machine-processes-mac")).toContainText("tranquillo · pressione della memoria 62%");
    await expect(pane.getByTestId("machine-processes-pc").getByTestId("machine-gauge-history")).toHaveCount(4);
    await expect(pane.getByTestId("machine-processes-mac").getByTestId("machine-gauge-history").first()).toHaveAttribute("aria-label", /Ultime 24 ore, picco \d+%/);

    // One Stop button, on the project script, with the project and the script.
    await expect(pane.getByTestId("machine-process-stop")).toHaveCount(1, { timeout: 20_000 });
    const dev = rows.filter({ has: page.getByTestId("machine-process-stop") });
    await expect(dev.getByTestId("machine-process-script")).toContainText("acme-web › dev");

    // The disk with its free space, the notes under the gauges, what the hub paused.
    await expect(pane.getByTestId("machine-gauge-disk")).toContainText("70%");
    await expect(pane.getByTestId("machine-gauge-disk")).toContainText("120 GB liberi");
    await expect(pane.getByTestId("machine-processes-mac")).toContainText("3,7 di 12 core");
    await expect(pane.getByTestId("machine-mac-line")).toHaveText("In pausa finché respira: studio-x");

    // PC, services (the proxy first among the live ones with a port), the log live.
    await expect(pane.getByTestId("machine-processes-pc")).toContainText("Acceso, lavora");
    const services = pane.getByTestId("machine-processes-services");
    await expect(services).toContainText("Proxy degli account");
    // A live service with a problem is one to look at: the foot never says all is on.
    await expect(services.getByTestId("machine-services-watch")).toHaveText("1 da guardare");
    await expect(services.getByTestId("machine-services-foot")).not.toContainText("Tutto acceso");
    // What each one is, its launchd job, its page, and the memory of what it started.
    await expect(services.getByTestId("machine-service-what")).toHaveText("Ruota gli account Claude");
    await expect(services).toContainText("com.example.switchboard");
    await expect(services.getByTestId("machine-service-link")).toHaveAttribute("href", "http://127.0.0.1:3360/");
    await expect(services).toContainText("con 12 figli 4,0 GB");
    // Off services are listed by name on request, not only counted.
    await expect(services).not.toContainText("Gateway vecchio");
    await services.getByTestId("machine-services-off").click();
    await expect(services.locator('[data-testid="machine-service-row"][data-state="spento"]')).toContainText("Gateway vecchio");
    const log = pane.getByTestId("machine-log-lines");
    await expect(log).toContainText("limite del provider", { timeout: 15_000 });
    // A long line wraps: its tail is on screen, not cut by an ellipsis.
    await expect(log).toHaveAttribute("role", "log");
    const long = log.getByTestId("machine-log-line").filter({ hasText: "fine-riga" });
    await expect(long).toBeVisible();
    expect(await long.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    // The stream's own greeting is not a line of the proxy.
    await expect(log).not.toContainText("Connected to log stream");
    await expect.poll(() => hub!.streams.opened).toBeGreaterThan(0);
    await page.screenshot({ path: testInfo.outputPath("vero-processi-macchina-scuro.png") });
    await page.emulateMedia({ colorScheme: "light" });
    await page.screenshot({ path: testInfo.outputPath("vero-processi-macchina-chiaro.png") });
    await page.emulateMedia({ colorScheme: "dark" });

    // The errors-only filter keeps the 429 and drops the 200s.
    await pane.getByTestId("machine-log-errors").click();
    await expect(log.locator("[data-tone]")).toHaveCount(1);
    await expect(log).toContainText("429");

    // Closing the log from the proxy's row ends the stream; reopening starts one.
    const before = hub!.streams.closed;
    await pane.getByTestId("machine-service-log-toggle").click();
    await expect(pane.getByTestId("machine-processes-log")).toHaveAttribute("data-open", "false");
    await expect.poll(() => hub!.streams.closed, { timeout: 10_000 }).toBeGreaterThan(before);
    const opened = hub!.streams.opened;
    await pane.getByTestId("machine-service-log-toggle").click();
    await expect.poll(() => hub!.streams.opened, { timeout: 10_000 }).toBeGreaterThan(opened);

    // The Stop button stops the real script: the row loses it.
    await dev.getByTestId("machine-process-stop").click();
    await expect(pane.getByTestId("machine-process-stop")).toHaveCount(0, { timeout: 20_000 });
    const stopped = await page.request.get(`${E2E_BASE}/api/scripts`);
    const list = ((await stopped.json()) as { scripts: Array<{ processId: string; status: string }> }).scripts;
    expect(list.find((s) => s.processId === script!.processId)?.status).not.toBe("running");

    // Closing the view's tab ends the stream too.
    const closedBefore = hub!.streams.closed;
    const tab = page.getByTestId("pane-tab-__processes__");
    await tab.hover();
    await tab.getByTestId("pane-tab-close").click();
    await expect(pane).toHaveCount(0);
    await expect.poll(() => hub!.streams.closed, { timeout: 10_000 }).toBeGreaterThan(closedBefore);
  });

  test("the palette has a «Processi» entry that opens the same view", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await goToApp(page);
    // The entry exists only once this window has read the hub (HUBBR-04): a
    // palette opened before the first snapshot lands has none, so reopen it
    // until the snapshot is in, instead of racing it.
    const search = page.getByPlaceholder(/Cerca topic/);
    await expect(async () => {
      if (await search.isVisible()) await page.keyboard.press("Escape");
      await page.keyboard.press("ControlOrMeta+k");
      await expect(search).toBeVisible({ timeout: 5_000 });
      await search.fill("Processi");
      await expect(page.getByTestId("palette-processes")).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 30_000 });
    await page.getByTestId("palette-processes").click();
    await expect(page.getByTestId(PANE)).toBeVisible({ timeout: 20_000 });
  });


  test("hub down while the view is open: the band says so, the last numbers stay, Retry is there", async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1100 });
    await goToApp(page);
    await openMainChat(page, scene!);
    await openFromMenu(page);
    const pane = page.getByTestId(PANE);
    await expect(pane.getByTestId("machine-process-row")).toHaveCount(8, { timeout: 20_000 });
    await expect(pane.getByTestId("machine-processes-hub-down")).toHaveCount(0);

    // The band comes from the hub-down frame or from the view's own failed
    // reads, whichever lands first: a socket that is reconnecting misses the frame.
    await hub!.close();
    await waitForHubDown(request);
    const band = pane.getByTestId("machine-processes-hub-down");
    await expect(band).toBeVisible({ timeout: 35_000 });
    await expect(band).toContainText("Hub non raggiungibile");
    await expect(band.getByRole("button", { name: "Riprova" })).toBeVisible();
    // The services are unknown, not "all up".
    await expect(pane.getByTestId("machine-processes-services")).toContainText("Stato non letto");
    await expect(pane.getByTestId("machine-processes-services")).not.toContainText("Tutto acceso");
    // The census read before the drop is still drawn: stale, and said to be.
    await expect(pane.getByTestId("machine-process-row")).toHaveCount(8);
    await expect(pane.getByTestId("machine-processes-mac").getByTestId("machine-gauge-history")).toHaveCount(2);
    // The PC's last state is not shown as current either, nor is the header's "now".
    await expect(pane.getByTestId("machine-processes-pc")).toContainText("Stato non letto");
    await expect(pane.getByTestId("machine-processes-pc")).not.toContainText("Acceso");
    await expect(pane.getByTestId("machine-processes-updated")).toContainText("Ultima lettura");
    await page.screenshot({ path: testInfo.outputPath("vero-processi-macchina-hub-fermo.png") });
    hub = null;
  });
});
