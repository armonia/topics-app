/**
 * HUBBR-22: the Processes view does what the tray did and Topics did not: search,
 * order, close a process (after a confirmation that names it), and the Mac
 * backup box. The hub is a fake (helpers/fake-hub.ts): the close request goes
 * to its `mac/procs/close`, so no real process is ever signalled. The fake
 * refuses a request whose birth instant is not the census's, like the service
 * does for a reused pid.
 *
 * Mutation: with `closeTarget` (lib/machineProcesses.ts) answering null, «close
 * asks first» is red (no row carries a Close button); with the birth instant
 * left out of the request, «a reused pid is refused» is red (the fake closes it).
 *
 * @covers HUBBR-22
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { resetPaneStore } from "./helpers/api-fixtures";
import { openPerfPanel } from "./helpers/open-perf-panel";
import { startFakeHub, type FakeHub } from "./helpers/fake-hub";
import { E2E_BASE } from "./helpers/test-server";

hermetic(test);
test.use({ video: "on" });
test.describe.configure({ mode: "serial", timeout: 150_000 });

const PANE = "machine-processes";
const HOUR = 3_600_000;

async function waitForHub(request: APIRequestContext): Promise<void> {
  await expect.poll(async () => {
    const snap = (await (await request.get(`${E2E_BASE}/api/hub-live`)).json()) as Record<string, { data?: { services?: unknown[] } }>;
    return snap.services?.data?.services?.length ?? -1;
  }, { timeout: 30_000, message: "the live reader never read the fake hub" }).toBeGreaterThan(0);
}

async function open(page: Page): Promise<void> {
  await page.goto("/");
  await openPerfPanel(page);
  await page.getByTestId("menu-system-processes").click();
  await expect(page.getByTestId(PANE)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("machine-process-row").first()).toBeVisible({ timeout: 20_000 });
}

const row = (page: Page, name: string) => page.getByTestId("machine-process-row").filter({ hasText: name });

test.describe("processes: search, order, close, backup", () => {
  let hub: FakeHub | null = null;

  test.beforeAll(async ({ request }) => {
    hub = await startFakeHub();
    await waitForHub(request);
  });
  test.afterAll(async () => { await hub?.close(); });
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, []);
    if (hub) { hub.closed = []; hub.posts = []; hub.answersOverride = {}; hub.backup = null; }
  });

  test("search narrows the list and order changes the first row", async ({ page }) => {
    await open(page);
    const rows = page.getByTestId("machine-process-row");
    await expect(rows.first()).toContainText("Gateway di Jarvis");
    await page.getByTestId("machine-processes-sort").selectOption("name");
    await expect(rows.first()).toContainText("Browser");
    await page.getByTestId("machine-processes-search").fill("container");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Container locali");
    await page.getByTestId("machine-processes-search").fill("zzz-nothing");
    await expect(page.getByTestId("machine-processes-empty")).toBeVisible();
  });

  test("close asks first, names the process, and only then signals; the system has no Close", async ({ page }) => {
    await open(page);
    await expect(row(page, "macOS").getByTestId("machine-process-close")).toHaveCount(0);
    await expect(row(page, "Gateway di Jarvis").getByTestId("machine-process-close")).toHaveCount(0);
    const browser = row(page, "Browser");
    await browser.getByTestId("machine-process-close").click();
    await expect(browser.getByTestId("machine-process-confirm")).toContainText("Browser");
    expect(hub!.closed).toEqual([]);
    await browser.getByTestId("machine-process-confirm-cancel").click();
    await expect(browser.getByTestId("machine-process-confirm")).toHaveCount(0);
    expect(hub!.closed).toEqual([]);
    await browser.getByTestId("machine-process-close").click();
    await browser.getByTestId("machine-process-confirm-term").click();
    await expect.poll(() => hub!.closed).toEqual([{ pid: 2401, signal: "TERM" }]);
    const containers = row(page, "Container locali");
    await containers.getByTestId("machine-process-close").click();
    await containers.getByTestId("machine-process-confirm-kill").click();
    await expect.poll(() => hub!.closed.at(-1)).toEqual({ pid: 2501, signal: "KILL" });
  });

  test("a pid the system reused is refused and says why", async ({ page }) => {
    hub!.answersOverride["mac/procs"] = {
      at: Date.now(),
      units: [{ id: "app:browser", name: "Browser", type: "app", memMB: 980, pids: [2401], procs: [{ pid: 2401, startedAt: 1 }], use: { text: "x" } }],
      summary: { processes: 1, units: 1, memMB: 980 },
    };
    await open(page);
    const browser = row(page, "Browser");
    await browser.getByTestId("machine-process-close").click();
    await browser.getByTestId("machine-process-confirm-term").click();
    await expect(browser).toContainText("pid reused");
    expect(hub!.closed).toEqual([]);
  });

  test("backup: no file says so, a file shows the last run and the ticks", async ({ page }) => {
    await open(page);
    await expect(page.getByTestId("machine-backup")).toHaveAttribute("data-state", "none");
    await expect(page.getByTestId("machine-backup-last")).toContainText("Nessun backup registrato");
    hub!.backup = {
      last: { at: Date.now() - 5 * HOUR, ok: true, detail: "1,2 GB in 4 min" },
      ticks: [0, 1, 2, 3].map((i) => ({ at: Date.now() - (4 - i) * 24 * HOUR, ok: i !== 1 })),
    };
    await open(page);
    await expect(page.getByTestId("machine-backup")).toHaveAttribute("data-state", "ok", { timeout: 20_000 });
    await expect(page.getByTestId("machine-backup-last")).toContainText("1,2 GB in 4 min");
    await expect(page.getByTestId("machine-backup-ticks").locator("i")).toHaveCount(4);
    await expect(page.getByTestId("machine-backup-ticks").locator('i[data-ok="false"]')).toHaveCount(1);
  });
});

test("hub off: no rows and no backup box, no error", async ({ page }) => {
  await page.goto("/");
  await openPerfPanel(page);
  await page.getByTestId("menu-system-processes").click().catch(() => {});
  await expect(page.getByTestId("machine-process-row")).toHaveCount(0);
  await expect(page.getByTestId("machine-backup")).toHaveCount(0);
});
