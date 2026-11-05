/**
 * THE PALETTE'S ENTRIES FOR THE HUB'S PLACES (hub-smistamento, HUBBR-19).
 *
 * With the fake hub answering, each of the eight entries opens its own place:
 * accounts and quotas, usage (the Dashboard), processes, features and
 * automations as views; the agents-and-jobs and agents-context entries as the
 * System levels, opened in the user menu with System already open; the log
 * entry as the processes view with its log section open and in sight. With
 * the hub gone, after a reload, none of the eight is offered.
 *
 * The hub is a fake (helpers/fake-hub.ts) on the port the test server reads;
 * the real :3360 is never touched.
 *
 * Mutation: with the context entry sending no level (`openUserMenu()`), the
 * context level never opens and the first test is red; with the log request
 * not read by the section (`takeProcessesLogRequest`), the log stays out of
 * sight and the first test is red.
 *
 * Video on: the recording is the proof.
 *
 * @covers HUBBR-19
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { goToApp } from "./helpers";
import { startFakeHub, type FakeHub } from "./helpers/fake-hub";
import { E2E_BASE } from "./helpers/test-server";

hermetic(test);
test.use({ video: "on" });
test.describe.configure({ mode: "serial", timeout: 180_000 });

async function waitForHub(request: APIRequestContext): Promise<void> {
  await expect.poll(async () => {
    const snap = (await (await request.get(`${E2E_BASE}/api/hub-live`)).json()) as Record<string, { data?: unknown[] }>;
    return Array.isArray(snap.pace?.data) ? snap.pace.data.length : -1;
  }, { timeout: 30_000, message: "the live reader never read the fake hub" }).toBe(3);
}

async function waitForHubDown(request: APIRequestContext): Promise<void> {
  await expect.poll(async () => {
    const snap = (await (await request.get(`${E2E_BASE}/api/hub-live`)).json()) as Record<string, { error?: string }>;
    return typeof snap.pace?.error;
  }, { timeout: 30_000 }).toBe("string");
}

/** Close whatever menu or palette is open, so the next shortcut lands on the app. */
async function closeAll(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) await page.keyboard.press("Escape");
}

/**
 * Opens the palette, types `query` and chooses `testId`. The entries exist only
 * once this window has read the hub, so the palette is reopened until they do.
 */
async function choose(page: Page, query: string, testId: string): Promise<void> {
  const search = page.getByPlaceholder(/Cerca topic/);
  await expect(async () => {
    if (await search.isVisible()) await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+k");
    await expect(search).toBeVisible({ timeout: 5_000 });
    await search.fill(query);
    await expect(page.getByTestId(testId)).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
  await page.getByTestId(testId).click();
  await expect(search).toHaveCount(0);
}

test.describe("palette: one entry per place of the hub", () => {
  let hub: FakeHub | null = null;

  test.beforeAll(async ({ request }) => {
    hub = await startFakeHub(undefined, { context: true, jobs: true, automations: true });
    await waitForHub(request);
  });
  test.afterAll(async () => { await hub?.close(); });

  test("each entry opens its place", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "dark" });
    await goToApp(page);

    // The palette lists the eight with their words.
    const search = page.getByPlaceholder(/Cerca topic/);
    await expect(async () => {
      if (await search.isVisible()) await page.keyboard.press("Escape");
      await page.keyboard.press("ControlOrMeta+k");
      await search.fill("agenti");
      await expect(page.getByTestId("palette-agents")).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 30_000 });
    await expect(page.getByTestId("palette-agents")).toContainText("Agenti e lavori");
    await expect(page.getByTestId("palette-context")).toContainText("Contesto degli agenti");
    await page.screenshot({ path: testInfo.outputPath("vero-cmdk-scuro.png") });
    await closeAll(page);

    const views: Array<[string, string, string]> = [
      ["Account e quote", "palette-accounts", "accounts-pane"],
      ["Consumi", "palette-usage", "dashboard-pane"],
      ["Processi", "palette-processes", "machine-processes"],
      ["Funzionalità", "palette-features", "features-pane"],
      ["Automazioni", "palette-automations", "automations-pane"],
    ];
    for (const [query, entry, place] of views) {
      await choose(page, query, entry);
      await expect(page.getByTestId(place).first()).toBeVisible({ timeout: 20_000 });
    }

    // The two levels of System, opened in the user menu.
    await choose(page, "Agenti e lavori", "palette-agents");
    await expect(page.getByTestId("menu-system-status-menu")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("agents-jobs-level")).toBeVisible({ timeout: 15_000 });
    await closeAll(page);
    await expect(page.getByTestId("agents-jobs-level")).toHaveCount(0);

    await choose(page, "Contesto", "palette-context");
    await expect(page.getByTestId("context-level")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("context-harness")).toHaveCount(4, { timeout: 20_000 });
    await closeAll(page);

    // «Log»: Processi with its log opened and in sight, after the person closed it.
    const pane = page.getByTestId("machine-processes");
    await choose(page, "Processi", "palette-processes");
    const toggle = pane.getByTestId("machine-service-log-toggle");
    await expect(toggle).toBeVisible({ timeout: 20_000 });
    await toggle.click();
    const log = pane.getByTestId("machine-processes-log");
    await expect(log).toHaveAttribute("data-open", "false");
    await pane.evaluate((el) => { el.scrollTop = 0; });
    await choose(page, "Log", "palette-log");
    await expect(log).toHaveAttribute("data-open", "true");
    await expect(log).toBeInViewport({ timeout: 10_000 });
  });

  test("on the phone the context level opens as a sheet", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await goToApp(page);
    await choose(page, "Contesto", "palette-context");
    await expect(page.getByTestId("context-level")).toBeVisible({ timeout: 15_000 });
  });

  test("hub gone, after a reload: none of the eight is offered", async ({ page, request }) => {
    await hub?.close();
    hub = null;
    await waitForHubDown(request);
    const errors: string[] = [];
    page.on("pageerror", (e) => { if (!e.message.startsWith("ResizeObserver loop")) errors.push(e.message); });
    await page.setViewportSize({ width: 1440, height: 900 });
    await goToApp(page);
    await page.keyboard.press("ControlOrMeta+k");
    const search = page.getByPlaceholder(/Cerca topic/);
    await expect(search).toBeVisible({ timeout: 5_000 });
    for (const q of ["Account", "Consumi", "Processi", "Agenti", "Contesto", "Funzionalità", "Log", "Automazioni"]) {
      await search.fill(q);
      await expect(page.locator('[data-testid="palette-accounts"], [data-testid="palette-usage"], [data-testid="palette-processes"], [data-testid="palette-agents"], [data-testid="palette-context"], [data-testid="palette-features"], [data-testid="palette-log"], [data-testid="palette-automations"]')).toHaveCount(0);
    }
    expect(errors).toEqual([]);
  });
});
