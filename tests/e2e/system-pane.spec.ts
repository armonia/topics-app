/**
 * THE SYSTEM PANE OPENS BESIDE THE WORK, NOT INSTEAD OF IT (HUBBR-04, HUBBR-05).
 *
 * Attilio chose the small version of the editorial variant
 * (the approved mockup under openspec/changes/hub-in-topics-bridge/), with the
 * words "do not change the tab system, at most make the small version". So the strip at the foot of the
 * sidebar opens one more column to the right of the chat: the chat stays on
 * screen, the top-level tabs do not change, and the pane shows waiting items,
 * agents, alerts, red gates and automations. Closing a waiting item goes to the
 * hub and comes back on the socket. On the phone the same content opens in the
 * bottom sheet.
 *
 * The hub is a fake (helpers/fake-hub.ts) on the port the test server is told
 * to read (`TOPICS_HUB_URL`): the real :3360 holds real items and is never
 * touched. Video on: this is behaviour, the recording is the proof.
 *
 * @covers HUBBR-04, HUBBR-05
 */
import { expect, test, type Page } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { goToApp, openTestChat } from "./helpers";
import { createTopic, deleteTopic } from "./helpers/api-fixtures";
import { defaultFakeHubItems, startFakeHub, type FakeHub } from "./helpers/fake-hub";
import { E2E_BASE } from "./helpers/test-server";

hermetic(test);
// The streaming route is faked with page.route: a service worker would answer
// it before the route sees it.
test.use({ video: "on", serviceWorkers: "block" });
test.describe.configure({ mode: "serial", timeout: 120_000 });

const SECTIONS = ["waiting", "agents", "alerts", "gates", "automations"];

async function expectSections(root: ReturnType<Page["locator"]>) {
  for (const id of SECTIONS) await expect(root.getByTestId(`system-section-${id}`)).toBeVisible();
}

test.describe("System pane beside the work", () => {
  let hub: FakeHub;

  test.beforeAll(async () => {
    hub = await startFakeHub();
  });
  test.afterAll(async () => {
    await hub?.close();
  });
  // A retry starts from the same items: the first attempt may have closed one.
  test.beforeEach(async ({ request }) => {
    test.setTimeout(120_000);
    const reset = await request.post(`${E2E_BASE}/api/hub/e2e-reset`, { data: {} });
    expect(reset.ok()).toBe(true);
    expect(hub.items.map((i) => i.id)).toEqual(defaultFakeHubItems().map((i) => i.id));
  });

  test("desktop: the strip opens the pane beside the chat, the sections are there, an item closes through the hub", async ({ page, request }, testInfo) => {
    // One chat mid-reply, said by the route the app reads for exactly this:
    // the Agents section is today's list of who works, not a second drawing.
    test.setTimeout(120_000);
    const worker = await createTopic(request, "E2E System Agent");
    await page.route("**/api/topics/streaming", (r) => r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ sessions: [{ topicId: worker.id, sessionKey: `k-${worker.id}`, state: "streaming" }] }),
    }));
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.emulateMedia({ colorScheme: "dark" });
      await goToApp(page);
      await openTestChat(page);
      // The worker chat has a (hidden) panel too: the work is the one on screen.
      const chat = page.getByTestId("chat-panel").filter({ visible: true }).first();
      await expect(chat).toBeVisible();
      const tabsBefore = await page.getByTestId("pane-tab-slot").count();

      // The strip reads the fake hub: attention, because one service is down,
      // one alert fires and one gate is red.
      const strip = page.getByTestId("system-strip");
      await expect(strip).toBeVisible();
      await expect(strip).toHaveAttribute("data-state", "attention");
      await expect(strip.getByTestId("system-strip-numbers")).toBeVisible();

      await strip.click();
      const pane = page.getByTestId("system-pane");
      await expect(pane).toBeVisible();
      await expect(strip).toHaveAttribute("aria-expanded", "true");

      // Beside, not instead: the chat is still on screen, to the LEFT of the
      // pane, and no top-level tab appeared.
      await expect(chat).toBeVisible();
      const chatBox = (await chat.boundingBox())!;
      const paneBox = (await pane.boundingBox())!;
      expect(chatBox.width).toBeGreaterThan(300);
      expect(chatBox.x + chatBox.width).toBeLessThanOrEqual(paneBox.x + 1);
      expect(await page.getByTestId("pane-tab-slot").count()).toBe(tabsBefore);
      await expect(page.getByLabel("Topics sidebar")).toBeVisible();

      await expectSections(pane);
      await expect(pane.getByTestId("system-waiting-item")).toHaveCount(3);
      await expect(pane.getByTestId("system-alert")).toHaveCount(1);
      await expect(pane.getByTestId("system-gate")).toHaveCount(1);
      await expect(pane.getByTestId("system-failed-job")).toHaveCount(1);
      await expect(pane.getByTestId("system-pane-count")).toHaveText("3");
      await expect(pane.getByTestId("system-section-agents").getByTestId("active-agent-row")).toHaveCount(1, { timeout: 20_000 });
      await expect(pane.getByTestId("system-section-agents")).toContainText("E2E System Agent");
      await page.screenshot({ path: testInfo.outputPath("vero-scuro.png") });

      await page.emulateMedia({ colorScheme: "light" });
      await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
      await page.screenshot({ path: testInfo.outputPath("vero-chiaro.png") });
      await page.emulateMedia({ colorScheme: "dark" });

      // Close one item: the hub gets the close, and the list that comes back on
      // the socket (the badge is read from it, not from the optimistic hide)
      // no longer has it.
      const first = pane.locator('[data-testid="system-waiting-item"][data-id="e2e-decide"]');
      await first.getByTestId("system-waiting-close").click();
      await expect(first).toHaveCount(0);
      await expect.poll(() => hub.posts).toContainEqual({ kind: "chiudi", ref: "e2e-decide" });
      await expect(pane.getByTestId("system-pane-count")).toHaveText("2");
      await expect(pane.getByTestId("system-waiting-item")).toHaveCount(2);

      // Open full view widens the same pane, and back.
      await pane.getByTestId("system-pane-open-full").click();
      await expect(pane).toHaveAttribute("data-maximized", "true");
      await pane.getByTestId("system-pane-maximize").click();
      await expect(pane).toHaveAttribute("data-maximized", "false");
      await expect(chat).toBeVisible();

      // The palette opens the same pane.
      await pane.getByTestId("system-pane-close").click();
      await expect(pane).toHaveCount(0);
      await page.keyboard.press("Meta+k");
      await page.getByLabel("Command palette").getByRole("textbox").fill("Sistema");
      await page.getByTestId("palette-system").click();
      await expect(page.getByTestId("system-pane")).toBeVisible();
      await expect(chat).toBeVisible();
    } finally {
      await deleteTopic(request, worker.id).catch(() => {});
    }
  });

  test("phone, 390 px: the strip above the bottom row opens the same content in the bottom sheet", async ({ browser }, testInfo) => {
    const ctx = await browser.newContext({
      baseURL: E2E_BASE, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: "dark",
      recordVideo: { dir: testInfo.outputPath("phone-video"), size: { width: 390, height: 844 } },
    });
    const page = await ctx.newPage();
    try {
      await page.goto("/");
      const strip = page.getByTestId("system-strip");
      await expect(strip).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId("system-pane")).toHaveCount(0);
      await strip.tap();
      const sheet = page.getByTestId("system-sheet");
      await expect(sheet).toBeVisible();
      // A sheet: it rests on the bottom edge and spans the screen.
      const box = (await sheet.boundingBox())!;
      expect(Math.round(box.x)).toBe(0);
      expect(Math.round(box.width)).toBe(390);
      expect(Math.round(box.y + box.height)).toBeGreaterThanOrEqual(840);
      await expectSections(sheet);
      await page.screenshot({ path: testInfo.outputPath("vero-telefono.png") });
    } finally {
      await ctx.close();
    }
  });
});
