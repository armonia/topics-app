import { test, expect } from "@playwright/test";
import { goToApp } from "./helpers";
import { resetPaneStore } from "./helpers/api-fixtures";
import { hostNativePage } from "./helpers/native-host-page";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/** @covers NATIVE-HOST-07 */
test("a Mac whose page stops answering is reported to the viewer within sixteen seconds", async ({ page, context, request }) => {
  const ctx = `e2e-host-away-${Date.now()}`;
  const html = "<!doctype html><title>Away host</title><p>Hosted page</p>";
  const host = await hostNativePage(await context.newPage(), ctx, html, {
    size: { width: 1000, height: 700 }, title: "Away host",
  });

  await resetPaneStore(request, [`browser:${ctx}`]);
  await goToApp(page);
  const mirror = page.locator('[data-testid="browser-dom-cobrowse"]').first();
  await expect(mirror.frameLocator("iframe").getByText("Hosted page", { exact: true })).toBeVisible({ timeout: 15_000 });
  // The 15 s rule holds a pane only once it has answered (an older client never does).
  await expect.poll(() => host.pongs(), { timeout: 15_000 }).toBeGreaterThan(0);
  await expect(page.getByTestId("browser-host-away")).toHaveCount(0);

  // The socket stays open and its protocol pongs keep coming: only the page is frozen,
  // the way a sleeping or stalled Mac looked for 90 s to the old heartbeat.
  host.freeze();
  const frozenAt = Date.now();
  await expect(page.getByTestId("browser-host-away")).toHaveText(
    "Il Mac non risponde. Se non torna, la pagina continua sul server.",
    { timeout: 20_000 },
  );
  // The last answer came at most one ping before the freeze: lost 15 s after it.
  expect(Date.now() - frozenAt).toBeLessThanOrEqual(17_000);
  host.close();
});
