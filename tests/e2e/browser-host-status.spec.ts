import { test, expect } from "@playwright/test";
import WebSocket from "ws";
import { goToApp } from "./helpers";
import { resetPaneStore } from "./helpers/api-fixtures";
import { hostNativePage } from "./helpers/native-host-page";
import { hermetic } from "./fixtures/hermetic";
import { E2E_BASE } from "./helpers/test-server";

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

  // A second viewer that ignores the paused screen, as an old or hostile client
  // would: its taps still reach the server, which is what must drop them.
  const rogue = new WebSocket(`${E2E_BASE.replace(/^http/, "ws")}/ws/browser/${encodeURIComponent(ctx)}`);
  await new Promise<void>((resolve, reject) => { rogue.once("open", () => resolve()); rogue.once("error", reject); });
  rogue.send(JSON.stringify({ type: "set_render", mode: "dom" }));
  await expect.poll(() => host.status()?.devices).toBe(2);
  const box = await host.page.locator("button").boundingBox();
  if (!box) throw new Error("the host page has no button");
  const tap = JSON.stringify({ type: "input", action: "click", payload: { x: box.x + box.width / 2, y: box.y + box.height / 2 } });
  const taps = () => host.page.evaluate(() => (window as unknown as { taps: number }).taps);
  // The control: while the Mac shares, this very tap reaches the page.
  rogue.send(tap);
  await expect.poll(taps).toBe(1);

  host.setSharing(false);
  await expect(page.getByTestId("browser-host-share-paused")).toHaveText("Condivisione sospesa");
  rogue.send(tap);
  // The server handles a socket's frames in order and its close after them:
  // once the Mac hears this viewer left, the paused tap has been dealt with.
  rogue.close();
  await expect.poll(() => host.status()?.devices).toBe(1);
  expect(await taps(), "a tap sent while the Mac does not share must not reach the page").toBe(1);
  host.setSharing(true);
  await expect(mirror.frameLocator("iframe").getByText("Page", { exact: true })).toBeVisible({ timeout: 15_000 });
  host.close();
});
