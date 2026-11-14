/**
 * OLD BOOKMARKS OF THE HUB (hub-tutto-in-topics, C2).
 *
 * `http://127.0.0.1:3360/#automations` answers a 302 to Topics without a
 * fragment, and the browser keeps the old one: Topics opens on
 * `/#automations`. That fragment opens the place of Topics that took the
 * page (`lib/hubPlaces.ts`) and leaves the address; one automation opens
 * Automazioni on it, the diary opens the bell on its History, and a fragment
 * that is not a page of the hub stays where it is.
 *
 * The hub is a fake (helpers/fake-hub.ts with `automations`) on the port the
 * test server reads; the real :3360 is never touched.
 *
 * Mutation: without the boot effect in `BootDeepLinkResolver` every case but
 * the unknown fragment is red (the views never open and the hash stays).
 *
 * Video on: the recording is the proof.
 *
 * @covers HUBBR-03
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { resetPaneStore } from "./helpers/api-fixtures";
import { startFakeHub, type FakeHub } from "./helpers/fake-hub";
import { E2E_BASE } from "./helpers/test-server";

hermetic(test);
test.use({ video: "on" });
// Not serial: the cases are independent (each starts from no tab), so one red does not hide the others.
test.describe.configure({ timeout: 120_000 });

async function waitForHub(request: APIRequestContext): Promise<void> {
  await expect.poll(async () => {
    const snap = (await (await request.get(`${E2E_BASE}/api/hub-live`)).json()) as Record<string, { data?: { needsYou?: number } }>;
    return snap.automations?.data?.needsYou ?? -1;
  }, { timeout: 30_000, message: "the live reader never read the fake hub" }).toBe(2);
}

/** Open Topics on a bookmark the hub's 302 sent here, fragment kept. */
async function openBookmark(page: Page, hash: string): Promise<void> {
  await page.goto(`/${hash}`);
  await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 20_000 });
}

test.describe("old bookmarks of the hub", () => {
  let hub: FakeHub | null = null;

  test.beforeAll(async ({ request }) => {
    hub = await startFakeHub(undefined, { automations: true });
    await waitForHub(request);
  });
  test.afterAll(async () => {
    await hub?.close();
  });
  // A view opened by the test before stays a tab: each case starts from no tab.
  test.beforeEach(async ({ request, page }) => {
    await resetPaneStore(request, []);
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  test("#automations opens Automazioni and leaves the address", async ({ page }) => {
    await openBookmark(page, "#automations");
    await expect(page.getByTestId("automations-pane")).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("");
  });

  test("#automations/<key> opens Automazioni on that automation", async ({ page }) => {
    await openBookmark(page, `#automations/${encodeURIComponent("launchd:com.example.backup")}`);
    await expect(page.getByTestId("automation-detail")).toHaveAttribute("data-key", "launchd:com.example.backup", { timeout: 20_000 });
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("");
  });

  test("#accounts opens Account e quote", async ({ page }) => {
    await openBookmark(page, "#accounts");
    await expect(page.getByTestId("accounts-pane")).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("");
  });

  test("#journal opens the bell on its History", async ({ page }) => {
    await openBookmark(page, "#journal");
    await expect(page.getByTestId("inbox-panel")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("inbox-panel-history")).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("");
  });

  test("a fragment that is not a page of the hub stays where it is", async ({ page }) => {
    await openBookmark(page, "#nowhere");
    // The bus a bookmark rides on is up once a sidebar row opens its view: by then a bookmark
    // would have fired, so the fragment must still be there and no bell must have opened.
    await page.getByTestId("sidebar-automations").click();
    await expect(page.getByTestId("automations-pane")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("inbox-panel")).toHaveCount(0);
    expect(await page.evaluate(() => window.location.hash)).toBe("#nowhere");
  });
});
