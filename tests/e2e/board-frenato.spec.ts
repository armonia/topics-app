/**
 * THE BOARD'S «FRENATO» CHIP (hub-smistamento, HUBBR-20).
 *
 * Claude's five-hour window is fed at 94% with a reset ahead, through the same
 * function the CLI's reading goes through (`/api/test/plan-usage`): the
 * dispatcher keeps Claude's cards in Todo, and the chip says so with the
 * provider, the share and the time. The popover lists Claude held, with the
 * threshold, and Codex free, and links to «Account e quote» (the fake hub
 * answers). Then Codex is held too (`/api/test/provider-hold`): the chip names
 * both and the first start again. With the window below the line and no hold,
 * there is no chip. On the phone the chip is a full-width row under the bar.
 *
 * The hub is a fake (helpers/fake-hub.ts) on the port the test server reads;
 * the real :3360 is never touched.
 *
 * Mutation: without the five-hour rule in `dispatchBrakes`
 * (server/lib/provider-hold.ts) the chip never shows and the first test is
 * red; with the Codex hold left out of it, the «Claude e Codex» check is red.
 *
 * Video on: the recording is the proof. The pictures of the built surface go
 * to the test's output (`vero-cmdk-e-frenato-*.png`, allow-italian: file names the docs expect).
 *
 * @covers HUBBR-20
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { startFakeHub, type FakeHub } from "./helpers/fake-hub";
import { E2E_BASE } from "./helpers/test-server";

hermetic(test);
test.use({ video: "on" });
test.describe.configure({ mode: "serial", timeout: 150_000 });

const HOUR = 3_600_000;

async function waitForHub(request: APIRequestContext): Promise<void> {
  await expect.poll(async () => {
    const snap = (await (await request.get(`${E2E_BASE}/api/hub-live`)).json()) as Record<string, { data?: unknown[] }>;
    return Array.isArray(snap.pace?.data) ? snap.pace.data.length : -1;
  }, { timeout: 30_000, message: "the live reader never read the fake hub" }).toBe(3);
}

async function clearBrakes(request: APIRequestContext): Promise<void> {
  await request.post(`${E2E_BASE}/api/test/plan-usage`, { data: { clear: true } });
  await request.post(`${E2E_BASE}/api/test/provider-hold`, { data: { provider: "codex", clear: true } });
}

/** «14:20» as the page writes a time, in the browser's own zone. */
function clock(page: Page, ms: number): Promise<string> {
  return page.evaluate((t) => new Date(t).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }), ms);
}

async function openBoard(page: Page): Promise<void> {
  await page.goto(E2E_BASE);
  await expect(page.locator('[aria-label="Topics sidebar"]').first()).toBeVisible({ timeout: 20_000 });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("topics:open-utility", { detail: { type: "board" } })));
  await expect(page.getByTestId("kanban-board").first()).toBeVisible({ timeout: 15_000 });
}

/** A reset still within today, so the chip reads «alle HH:MM» on any clock. */
function resetToday(): number {
  const now = Date.now();
  const end = new Date(now);
  end.setHours(23, 59, 0, 0);
  return Math.min(now + 2 * HOUR, end.getTime());
}

test.describe("board: the «Frenato» chip", () => {
  let hub: FakeHub | null = null;

  test.beforeAll(async ({ request }) => {
    hub = await startFakeHub();
    await waitForHub(request);
  });
  test.afterAll(async ({ request }) => {
    await clearBrakes(request);
    await hub?.close();
  });
  test.beforeEach(async ({ request }) => { await clearBrakes(request); });

  test("Claude past the line: the chip, the popover, then Codex held too", async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "dark" });
    const resetsAtMs = resetToday();
    await request.post(`${E2E_BASE}/api/test/plan-usage`, { data: { fiveHour: { utilization: 94, resetsAtMs } } });
    await openBoard(page);

    const chip = page.getByTestId("board-brake-chip");
    await expect(chip).toBeVisible({ timeout: 20_000 });
    const at = await clock(page, resetsAtMs);
    await expect(chip).toHaveText(`Frenato · Claude · quota 5h al 94%, riparte alle ${at}`);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: testInfo.outputPath("vero-cmdk-e-frenato-scuro.png") });

    await chip.click();
    const pop = page.getByTestId("board-brake-pop");
    await expect(pop).toBeVisible();
    await expect(pop.getByTestId("board-brake-row-claude")).toHaveAttribute("data-held", "true");
    await expect(pop.getByTestId("board-brake-row-claude")).toContainText(`Quota 5h al 94%, riparte alle ${at} (soglia 90%)`);
    await expect(pop.getByTestId("board-brake-row-codex")).toHaveAttribute("data-held", "false");
    await expect(pop.getByTestId("board-brake-row-codex")).toContainText("Libero");
    await expect(pop).not.toContainText("Togli il freno");
    await page.screenshot({ path: testInfo.outputPath("vero-cmdk-e-frenato-popover-scuro.png") });
    await pop.getByTestId("board-brake-accounts").click();
    await expect(page.getByTestId("accounts-pane")).toBeVisible({ timeout: 20_000 });

    // Codex held too, later than Claude: both names, Claude's earlier time.
    await request.post(`${E2E_BASE}/api/test/provider-hold`, { data: { provider: "codex", untilMs: resetsAtMs + 60_000, window: "usage_limit" } });
    // Back on the board, in a fresh page: the chip reads the brakes again on mount.
    await openBoard(page);
    await expect(page.getByTestId("board-brake-chip")).toHaveText(`Frenato · Claude e Codex · riparte alle ${at}`, { timeout: 20_000 });
  });

  test("light: the chip and its popover", async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "light" });
    await request.post(`${E2E_BASE}/api/test/plan-usage`, { data: { fiveHour: { utilization: 94, resetsAtMs: resetToday() } } });
    await openBoard(page);
    const chip = page.getByTestId("board-brake-chip");
    await expect(chip).toBeVisible({ timeout: 20_000 });
    await page.mouse.move(0, 0);
    await page.screenshot({ path: testInfo.outputPath("vero-cmdk-e-frenato-chiaro.png") });
    await chip.click();
    await expect(page.getByTestId("board-brake-pop")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("vero-cmdk-e-frenato-popover-chiaro.png") });
  });

  test("phone: a full-width row under the bar", async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark" });
    await request.post(`${E2E_BASE}/api/test/plan-usage`, { data: { fiveHour: { utilization: 94, resetsAtMs: resetToday() } } });
    await openBoard(page);
    const band = page.getByTestId("board-brake-band");
    await expect(band).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("board-brake-chip")).toBeHidden();
    const box = (await band.boundingBox())!;
    expect(box.width).toBeGreaterThan(330);
    expect(box.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: testInfo.outputPath("vero-cmdk-e-frenato-telefono.png") });
  });

  test("nothing held: no chip", async ({ page, request }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await request.post(`${E2E_BASE}/api/test/plan-usage`, { data: { fiveHour: { utilization: 60, resetsAtMs: resetToday() } } });
    await openBoard(page);
    // The store has read the server: the answer is empty, and stays so.
    await expect.poll(async () => (await (await request.get(`${E2E_BASE}/api/dispatch/brakes`)).json()) as unknown).toEqual({ brakes: [] });
    await expect(page.getByTestId("board-toolbar")).toBeVisible();
    await expect(page.getByTestId("board-brake-chip")).toHaveCount(0);
    await expect(page.getByTestId("board-brake-band")).toHaveCount(0);
  });
});
