import { test, expect } from "@playwright/test";
import { goToApp } from "./helpers";
import { resetPaneStore } from "./helpers/api-fixtures";
import { hostNativePage } from "./helpers/native-host-page";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/** @covers BROWSER-NATIVE-HOST-STATUS-01 */
test("native host status and sharing switch reach the viewer", async ({ page, context, request }) => {
  const ctx = `e2e-host-status-${Date.now()}`;
  const html = "<!doctype html><title>Status host</title><button onclick=\"window.taps++\">Page</button><script>window.taps=0</script>";
  const host = await hostNativePage(await context.newPage(), ctx, html, {
    size: { width: 1000, height: 700 }, title: "Status host",
  });

  await resetPaneStore(request, [`browser:${ctx}`]);
  await goToApp(page);
  const mirror = page.locator('[data-testid="browser-dom-cobrowse"]').first();
  await expect(mirror.frameLocator("iframe").getByText("Page", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => host.status()?.devices).toBe(1);

  host.setSharing(false);
  await expect(page.getByTestId("browser-host-share-paused")).toHaveText("Condivisione sospesa");
  host.setSharing(true);
  await expect(mirror.frameLocator("iframe").getByText("Page", { exact: true })).toBeVisible({ timeout: 15_000 });
  host.close();
});
