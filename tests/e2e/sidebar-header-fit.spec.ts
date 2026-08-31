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
      const elementOnTop = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) as HTMLElement | null;
      // WHO is on top, not just whether somebody is. The identical defect in
      // August was solved the moment Playwright named the culprit
      // (`div.cursor-col-resize` intercepts pointer events); a boolean sends
      // whoever reads the red back to guessing, and the guess costs a CI round
      // trip each time. The rect comes too: a covering element that is nowhere
      // near the bell means the layout had not settled, which is a different
      // defect from one that overlaps by construction.
      const on = elementOnTop?.getBoundingClientRect();
      return {
        sporge: Math.round(r.right - group.right),
        riceveIlClick: b.contains(elementOnTop),
        bell: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)],
        whatCovers: elementOnTop
          ? `${elementOnTop.tagName.toLowerCase()}${elementOnTop.getAttribute('data-testid') ? `[${elementOnTop.getAttribute('data-testid')}]` : ''}.${(elementOnTop.getAttribute('class') || '').slice(0, 80)} @${on ? [Math.round(on.left), Math.round(on.top), Math.round(on.right), Math.round(on.bottom)].join(',') : '?'}`
          : 'nessuno (elementFromPoint ha risposto null)',
      };
    });
    expect(misura, "the bell must exist in the row").not.toBeNull();

    // The click reaches the button and not what sits on top of it: that is the
    // property that matters, and the only one a user would notice.
    expect(
      misura!.riceveIlClick,
      `something covers the bell — on top: ${misura!.whatCovers}; bell @${misura!.bell.join(",")}`,
    ).toBe(true);
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
  // THE PROPERTY, not an occupant. This used to name the bottom-most control —
  // the org chip, else the identity profile row — and both moved into the
  // «Topics» menu on 2026-08-31 with the rest of the status bar
  // (SIDEBAR-STATUS-01). The test then failed for a reason that had nothing to
  // do with the handle, and naming a replacement only moves the same trap: the
  // next occupant is a hover-revealed row action, covered at rest by its own
  // unread badge, so "the last visible button" is not down there either.
  //
  // What the handle must never do is INTERCEPT the column outside its own
  // strip. That is asked directly, at the bottom-left of the sidebar — the
  // corner furthest from the handle, where nothing of it has any business
  // being — and it holds whoever is living there.
  const whatCovers = await page.evaluate(() => {
    const side = document.querySelector('[aria-label="Topics sidebar"]') as HTMLElement | null;
    if (!side) return { missing: 'no sidebar' };
    const r = side.getBoundingClientRect();
    const x = Math.round(r.left + 24);
    const y = Math.round(r.bottom - 12);
    const el = document.elementFromPoint(x, y);
    const handle = el?.closest('.cursor-col-resize') ?? null;
    return {
      point: [x, y],
      tag: el ? el.tagName.toLowerCase() : 'null',
      classes: el ? String((el as HTMLElement).className).slice(0, 70) : '',
      isTheHandle: !!handle,
    };
  });
  expect(whatCovers.missing, 'the sidebar must be there').toBeUndefined();
  expect(
    whatCovers.isTheHandle,
    `the handle covers the foot of the column: at ${JSON.stringify(whatCovers.point)} the answer is ${whatCovers.tag}.${whatCovers.classes}`,
  ).toBe(false);

  // And the handle must stay grabbable where it is needed, i.e. above: a cure
  // that switched it off entirely would pass this test and break the resize.
  const handle = page.locator(".cursor-col-resize").first();
  await expect(handle).toBeAttached();
  const box = await handle.boundingBox();
  expect(box, "the handle must have a box").not.toBeNull();
  expect(box!.height, "the handle must not vanish").toBeGreaterThan(200);
});

