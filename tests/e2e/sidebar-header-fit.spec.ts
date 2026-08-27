/**
 * @covers LAYOUT-01
 *
 * The top row of the sidebar has to HOLD what it shows, on every platform.
 *
 * It did not: where the primary modifier is Ctrl the shortcut hints are wider
 * ("Ctrl+K" against "⌘K"), the row ran 37px short, and the notification bell was
 * pushed out of its own group and underneath the one on `z-50` — still visible,
 * still "enabled and stable" to Playwright, and no longer clickable. Twelve
 * `notification-history` cases timed out on Linux CI for this, with the pointer
 * intercepted by the magnifier's `<circle>`.
 *
 * The platform is faked rather than waited for: `usesCtrl` reads
 * `navigator.platform` / `userAgentData.platform`, so a Mac can run the Windows
 * and Linux case too — which is the whole point, since nobody has one of those
 * open while writing this.
 */
import { test, expect } from "@playwright/test";
import { goToApp } from "./helpers";
import { hermetic } from "./fixtures/hermetic";

// Every spec starts from the same server state: `check-e2e-hermetic` demands it,
// and it is right — a file that inherits what the previous one left behind goes
// red somewhere else, on someone else's change.
hermetic(test);

for (const [nome, platform] of [["Mac", "MacIntel"], ["non-Mac", "Linux x86_64"]] as const) {
  test(`SIDEBAR-FIT: on ${nome} the bell stays clickable`, async ({ page }) => {
    await page.addInitScript((p) => {
      Object.defineProperty(navigator, "platform", { get: () => p });
      Object.defineProperty(navigator, "userAgentData", {
        get: () => ({ platform: p === "MacIntel" ? "macOS" : "Linux" }),
      });
    }, platform);
    await goToApp(page);

    const misura = await page.evaluate(() => {
      const b = document.querySelector('[data-testid="notification-history-button"]') as HTMLElement | null;
      if (!b) return null;
      const r = b.getBoundingClientRect();
      const group = b.parentElement!.getBoundingClientRect();
      const elementOnTop = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { sporge: Math.round(r.right - group.right), riceveIlClick: b.contains(elementOnTop) };
    });
    expect(misura, "the bell must exist in the row").not.toBeNull();

    // The click reaches the button and not what sits on top of it: that is the
    // property that matters, and the only one a user would notice.
    expect(misura!.riceveIlClick, "something covers the bell").toBe(true);
    // And it does not stick out of the group holding it: that is the CAUSE, and
    // measuring it fails the test where the defect starts, not where it shows.
    expect(misura!.sporge, "the bell sticks out of its group").toBeLessThanOrEqual(0);

    // The final proof is the gesture: if the panel opens, the click got through.
    await page.getByTestId("notification-history-button").click({ timeout: 8_000 });
    await expect(page.getByTestId("notification-history-panel")).toBeVisible({ timeout: 8_000 });
  });
}

/**
 * AND THE OTHER END OF THE SAME COLUMN: the resize handle must not sit on the
 * commands at the bottom.
 *
 * The handle is a 10px band deliberately biased INTO the sidebar (native panes
 * on the content side would eat anything past the edge) and it used to run the
 * full height. At the bottom that put it on top of the identity block, whose
 * rightmost control — the organisation chip — ends exactly under it: not
 * clickable at all, on every platform, and no test had ever tried.
 */
test("SIDEBAR-FIT: the resize handle does not cover the commands at the bottom", async ({ page }) => {
  await goToApp(page);
  // NOT `test.skip` when there is no organisation. A skip that depends on the
  // data makes the case disappear exactly where nobody is looking, and it costs
  // the gate a number it has to justify. The subject here is not the chip: it is
  // "whatever the sidebar shows at the bottom, the handle must not sit on it",
  // and the identity block is always there.
  //
  // The bottom-most control is taken as it comes: the org chip when there is an
  // organisation, otherwise the profile row, which never goes away.
  const chip = page.getByTestId("org-chip");
  const target = (await chip.count()) > 0 ? chip.first() : page.getByTestId("identity-me-profile").first();
  await expect(target).toBeVisible({ timeout: 10_000 });

  // `trial` attempts the click WITHOUT performing it: what matters is whether
  // the pointer LANDS, not what the panel opens.
  await target.click({ trial: true, timeout: 8_000 });

  // And the handle must stay grabbable where it is needed, i.e. above: a cure
  // that switched it off entirely would pass this test and break the resize.
  const handle = page.locator(".cursor-col-resize").first();
  await expect(handle).toBeAttached();
  const box = await handle.boundingBox();
  expect(box, "the handle must have a box").not.toBeNull();
  expect(box!.height, "the handle must not vanish").toBeGreaterThan(200);
});

