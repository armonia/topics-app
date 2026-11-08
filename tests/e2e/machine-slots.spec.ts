import { test, expect } from "./fixtures/test-fixtures";
import { goToApp } from "./helpers";
import { hermetic } from "./fixtures/hermetic";
import { openUserMenuLevel } from "./helpers/user-menu";

hermetic(test);

/**
 * «CARDS AT ONCE» ON A PAIRED NODE (card cbf3b91d).
 *
 * The Machines section shows one number field per node; typing a value and
 * leaving the field sends `PATCH /api/machines/:id { slots }`.
 * @covers MACHINE-02
 */
test("the Machines section declares how many cards a node runs at once", async ({ page }) => {
  const node = {
    id: "pc-1", name: "PC", hostname: "pc:1", arch: "", platform: "", daemonVersion: "0.0.0",
    status: "online", lastHeartbeatAt: "", lastSeenAt: "", acknowledgedWarnings: {},
    baseUrl: "https://pc.local", slots: null, createdAt: "", updatedAt: "",
  };
  const patches: unknown[] = [];
  await page.route("**/api/machines", (route) => route.fulfill({ json: { machines: [node] } }));
  await page.route("**/api/machines/pc-1", async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    patches.push(route.request().postDataJSON());
    await route.fulfill({ json: { ...node, slots: 4 } });
  });
  await goToApp(page);
  const panel = await openUserMenuLevel(page, "nodes");
  const field = panel.getByTestId("node-slots-pc-1");
  await expect(field).toBeVisible({ timeout: 15_000 });
  await field.fill("4");
  await field.blur();
  await expect.poll(() => patches.length).toBe(1);
  expect(patches[0]).toEqual({ slots: 4 });
});
