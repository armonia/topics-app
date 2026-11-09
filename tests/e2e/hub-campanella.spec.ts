/**
 * Bell, hub side (track S1 of the hub-in-Topics change).
 *
 * The bell's «Now» tab lists the hub's «waiting for you» items with the
 * deadlines first, the broken and quota groups from the hub's services,
 * alerts and gates; the done button posts a close to the hub's
 * waiting-list route. The hub is a fake (helpers/fake-hub.ts) on the port the
 * test server reads; the real ones are never touched.
 *
 * Complements bell-groups.spec.ts (which also covers the Topics-side subjects)
 * with the hub-only angle: the order of the groups, «decidi tu in cima», the
 * close that removes the item from the hub itself, and the hub switched off:
 * no hub row, no error.
 *
 * Mutation: with the hub's source taken out of the bell (`useBellHub`
 * answering no hub), «decidi tu in cima» is red: the first row of the group is
 * not the item due first.
 *
 * Video on: the recording is the proof.
 *
 * @covers HUBBR-06
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { goToApp } from "./helpers";
import { startFakeHub, type FakeHub } from "./helpers/fake-hub";
import { openMainChat, seedScene, type Scene } from "./helpers/shot-scene";
import { E2E_BASE, canonicalTmpRoot } from "./helpers/test-server";

hermetic(test);
test.use({ video: "on" });
test.describe.configure({ mode: "serial", timeout: 120_000 });

const panel = (page: Page) => page.getByTestId("inbox-panel");

async function hubItems(request: APIRequestContext): Promise<number> {
  const snap = (await (await request.get(`${E2E_BASE}/api/hub-live`)).json()) as Record<string, { data?: { items?: unknown[] } }>;
  return snap.attesa?.data?.items?.length ?? -1;
}

async function waitForHubDown(request: APIRequestContext): Promise<void> {
  await expect.poll(async () => {
    const snap = (await (await request.get(`${E2E_BASE}/api/hub-live`)).json()) as Record<string, { error?: string }>;
    return typeof snap.pace?.error;
  }, { timeout: 30_000 }).toBe("string");
}

test.describe("the bell, hub side", () => {
  let scene: Scene | null = null;
  test.beforeAll(async ({ request }) => {
    scene = await seedScene(request, `${canonicalTmpRoot()}/e2e-hub-campanella-${Date.now().toString(36)}`);
  });
  test.afterAll(async ({ request }) => {
    await scene?.cleanup(request);
  });

  test("hub up: deadline first, the five-group order holds, «Fatto» closes the item on the hub", async ({ page, request }) => {
    const hub: FakeHub = await startFakeHub();
    try {
      await expect.poll(() => hubItems(request), { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
      await page.setViewportSize({ width: 1440, height: 1100 });
      await goToApp(page);
      await openMainChat(page, scene!);
      await page.getByTestId("inbox-button").click();
      await expect(panel(page)).toBeVisible();

      const keys = () => panel(page).locator("[data-bell-group]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.bellGroup));
      await expect.poll(keys, { timeout: 15_000 }).toEqual(expect.arrayContaining(["decide", "broken", "quota", "look"]));
      const order = (await keys()) as string[];
      expect(order[0]).toBe("decide");
      expect(order.indexOf("broken")).toBeLessThan(order.indexOf("quota"));
      expect(order.indexOf("quota")).toBeLessThan(order.indexOf("look"));

      const decide = panel(page).getByTestId("inbox-waiting");
      const rows = decide.locator("li");
      await expect(rows.first()).toHaveAttribute("data-source", "waiting");
      await expect(rows.first()).toContainText("Passare studio-x al piano Launch");
      const before = Number(await decide.getAttribute("data-count"));

      await rows.first().getByTestId("bell-done").click();
      await expect(decide).toHaveAttribute("data-count", String(before - 1));
      await expect(decide).not.toContainText("Passare studio-x al piano Launch");
      expect(hub.posts).toContainEqual({ kind: "chiudi", ref: "e2e-spend" });
      expect(hub.items.some((i) => i.id === "e2e-spend")).toBe(false);
    } finally {
      await hub.close();
      await waitForHubDown(request);
    }
  });

  test("hub off: the bell shows no hub row and raises no error", async ({ page, request }) => {
    await waitForHubDown(request);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setViewportSize({ width: 1440, height: 900 });
    await goToApp(page);
    await openMainChat(page, scene!);
    await expect(page.getByTestId("inbox-button")).toBeVisible();
    await page.getByTestId("inbox-button").click();
    await expect(panel(page).locator('[data-source="waiting"]')).toHaveCount(0);
    await expect(panel(page).getByTestId("bell-group-broken")).toHaveCount(0);
    await expect(panel(page).getByTestId("bell-group-quota")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
