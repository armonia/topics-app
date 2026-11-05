/**
 * THE MACHINE'S PROCESSES (hub-smistamento, HUBBR-08 and HUBBR-09).
 *
 * Sistema in the Topics menu opens «Processi»: the Mac with GPU and network
 * per process (a dash where the hub did not measure), the PC, the services and
 * the Claude proxy's log, live. The only «Ferma» is on a project script Topics
 * started: here a real script of a scratch project, whose pid the fake census
 * puts in the dev server's unit, so the stop is the real one. Closing the
 * view's tab closes the proxy's stream (the fake counts it).
 *
 * The hub is a fake (helpers/fake-hub.ts) on the port the test server reads;
 * the real :3360 and :3335 are never touched, and the names are placeholders.
 *
 * Mutation: with `scriptForUnit` (lib/machineProcesses.ts) answering null, «only the script stops» is
 * red (no row carries «Ferma»); with the EventSource left open on unmount,
 * «closed with the view» is red (the fake never sees the stream end).
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
import { goToApp } from "./helpers";
import { openPerfPanel } from "./helpers/open-perf-panel";
import { startFakeHub, type FakeHub } from "./helpers/fake-hub";
import { E2E_BASE } from "./helpers/test-server";

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

  test.beforeAll(async ({ request }) => {
    hub = await startFakeHub();
    await waitForHub(request);
    script = await startScript(request);
    hub.devPids = [script.pid];
  });
  test.afterAll(async ({ request }) => {
    if (script) await request.post(`${E2E_BASE}/api/scripts/${script.processId}/stop`).catch(() => {});
    await hub?.close();
    await waitForHubDown(request);
  });

  test("Sistema opens Processi: GPU and network per process, a dash where not measured, «Ferma» only on the script; the log closes with the view", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.emulateMedia({ colorScheme: "dark" });
    await goToApp(page);
    await openFromMenu(page);
    const pane = page.getByTestId(PANE);
    const rows = pane.getByTestId("machine-process-row");
    await expect(rows).toHaveCount(8, { timeout: 20_000 });

    // Measured rows show GPU and network; the system's row has no network and shows the dash.
    const topics = rows.filter({ has: page.getByText("Topics", { exact: true }) });
    await expect(topics.getByTestId("machine-process-gpu")).toHaveText("12%");
    await expect(topics.getByTestId("machine-process-net")).toContainText("120 KB/s");
    await expect(topics.getByTestId("machine-process-cpu")).toHaveText("18%");
    const system = rows.filter({ has: page.getByText("macOS", { exact: true }) });
    await expect(system.getByTestId("machine-process-net")).toHaveText("-");
    await expect(rows.filter({ hasText: "Container locali" }).getByTestId("machine-process-cpu")).toHaveText("-");
    await expect(pane.getByTestId("machine-processes-more")).toContainText("Altri 6 processi");

    // One «Ferma», on the project script, with the project and the script.
    await expect(pane.getByTestId("machine-process-stop")).toHaveCount(1, { timeout: 20_000 });
    const dev = rows.filter({ has: page.getByTestId("machine-process-stop") });
    await expect(dev.getByTestId("machine-process-script")).toContainText("acme-web › dev");

    // PC, services (the proxy first among the live ones with a port), the log live.
    await expect(pane.getByTestId("machine-processes-pc")).toContainText("Acceso, lavora");
    await expect(pane.getByTestId("machine-processes-services")).toContainText("Proxy degli account");
    const log = pane.getByTestId("machine-log-lines");
    await expect(log).toContainText("limite del provider", { timeout: 15_000 });
    await expect.poll(() => hub!.streams.opened).toBeGreaterThan(0);
    await page.screenshot({ path: testInfo.outputPath("vero-processi-macchina-scuro.png") });
    await page.emulateMedia({ colorScheme: "light" });
    await page.screenshot({ path: testInfo.outputPath("vero-processi-macchina-chiaro.png") });
    await page.emulateMedia({ colorScheme: "dark" });

    // «Solo errori» keeps the 429 and drops the 200s.
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

    // «Ferma» stops the real script: the row loses it.
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
    await page.keyboard.press("ControlOrMeta+k");
    const search = page.getByPlaceholder(/Cerca topic/);
    await expect(search).toBeVisible({ timeout: 10_000 });
    await search.fill("Processi");
    await page.getByTestId("palette-processes").click();
    await expect(page.getByTestId(PANE)).toBeVisible({ timeout: 20_000 });
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
});
