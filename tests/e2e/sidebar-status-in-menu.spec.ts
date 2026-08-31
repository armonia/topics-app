import { expect, test } from "@playwright/test";
import { goToApp } from "./helpers";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/**
 * The status bar moved INTO the «Topics» menu, and what stayed outside.
 *
 * Asked for on 2026-08-31: «it has to go inside the topics dropdown menu». It is
 * the same place the phone has had it since 07/08, so the two populations stop
 * carrying two different maps of the same app.
 *
 * The cut is not "everything inside". An ALARM is not a statistic: how much
 * memory you are using is something you look at when you go looking for it, but
 * "you are offline" behind a gesture means the app is disconnected and whoever
 * is watching does not know until they open a menu. So one lamp stays in the
 * title row — and it stays in the DOM at all times, because half the suite uses
 * that testid to know the app is up, and a handle that exists only when things
 * go wrong is a handle that never exists.
 *
 * The identity band did NOT travel with it, and that is the deliberate half.
 * Its contract is responsive — the three subjects hold one line at sidebar
 * widths 180, 256 and 400 (CHIPS-01) — and the desktop dropdown has a width of
 * its own that does not follow the column: moving the band in would not have
 * relocated it, it would have deleted the contract it exists to satisfy. It is
 * also the half that sent the bar back to the foot on 07/08 — «where did the
 * accounts go?» — so leaving it there settles two things with one decision.
 *
 * @covers SIDEBAR-STATUS-01
 */
test.describe("Lo stato vive nel menu «Topics»", () => {
  test("la colonna non ha più una barra in fondo, e la spia è fuori", async ({ page }) => {
    await goToApp(page);

    // 1) NO BAR in the column. Not "invisible": actually absent.
    await expect(page.locator('[data-testid="sidebar-status-bar"]')).toHaveCount(0);

    // 2) THE LAMP IS THERE with the menu closed, and it is the readiness
    //    handle layout.fixture / multi-client / tab-sync have always used.
    const lamp = page.locator('[data-testid="connection-status"]');
    await expect(lamp).toBeVisible({ timeout: 15_000 });
    // And it is in the title row, not a leftover at the foot: measured, not
    // inferred — it must sit in the UPPER half of the column.
    const dove = await page.evaluate(() => {
      const s = document.querySelector('[data-testid="connection-status"]')!.getBoundingClientRect();
      const col = document.querySelector('[aria-label="Topics sidebar"]')!.getBoundingClientRect();
      return { spiaY: Math.round(s.y), metaColonna: Math.round(col.y + col.height / 2) };
    });
    expect(dove.spiaY, `la spia è a ${dove.spiaY}, la metà colonna a ${dove.metaColonna}`).toBeLessThan(dove.metaColonna);

    // 3) IT DOES NOT SHOUT WHEN ALL IS WELL: no alarm declared.
    await expect(lamp).not.toHaveAttribute("data-alarm", "true");
  });

  test("aprendo il menu ci sono i numeri e la versione; l'identità resta in colonna", async ({ page }) => {
    await goToApp(page);
    await page.getByTestId("sidebar-topics-menu").click();

    // The state is IN HERE.
    await expect(page.locator('[data-testid="sidebar-status-bar"]')).toBeVisible({ timeout: 10_000 });
    // The numbers read without expanding the panel (PERFPANEL-01).
    await expect(page.locator('[data-testid="metrics-total"]')).toBeVisible();
    // The identity did NOT: it stayed at the foot of the column, outside the
    // menu, because its contract is the column's width (CHIPS-01) and the menu
    // does not follow it. Both where it is NOT and where it IS are asserted:
    // without the second check this would pass with the band gone entirely.
    const insideTheMenu = page.locator('[data-testid="sidebar-system-menu"], [role="menu"]').locator('[data-testid="identity-row-me"]');
    await expect(insideTheMenu).toHaveCount(0);
    await expect(page.locator('[data-testid="identity-row-me"]')).toBeVisible();
  });

  test("il trigger ha UNA spia sola, e non cambia misura al click", async ({ page }) => {
    await goToApp(page);
    const trigger = page.getByTestId("sidebar-topics-menu");
    await expect(trigger).toBeVisible({ timeout: 15_000 });

    // 1) ONE. Reported from the real UI: «I now see two dots in the trigger».
    //    There were two because the alarm lamp had been added NEXT TO
    //    `TopicsLoadDot`, which already did that job. Two dots 4px apart are not
    //    two signals: they are one signal that looks broken. Small ROUND things
    //    are counted, not testids, because the defect was precisely having two
    //    different elements that look alike.
    const round = await trigger.evaluate((el) =>
      Array.from(el.querySelectorAll("*")).filter((n) => {
        const r = n.getBoundingClientRect();
        if (r.width === 0 || r.width > 12 || Math.abs(r.width - r.height) > 1) return false;
        // "Round" is decided on the RADIUS against half the side, not on a
        // string: `rounded-full` writes 9999px, another could write 50% or 4px,
        // and matching the string reported "zero dots" for a trigger that had
        // two.
        const radius = parseFloat(getComputedStyle(n).borderTopLeftRadius) || 0;
        const pct = getComputedStyle(n).borderTopLeftRadius.includes("%");
        return pct || radius >= r.width / 2 - 0.5;
      }).map((n) => `${n.tagName.toLowerCase()}[${n.getAttribute("data-testid") ?? "-"}] ${Math.round(n.getBoundingClientRect().width)}px`),
    );
    expect(round, `round things in the trigger: ${JSON.stringify(round)}`).toHaveLength(1);

    // 2) IT DOES NOT RESIZE. «it should not resize on click»: the lamp was
    //    UNMOUNTED when the menu opened, so the row narrowed under the finger
    //    that had just clicked it — measured 93.8px -> 79.8px. It now goes
    //    `invisible`, like the title beside it: same space, not shown.
    const before = (await trigger.boundingBox())!;
    await trigger.click();
    await expect(page.locator('[data-testid="sidebar-status-bar"]')).toBeVisible({ timeout: 10_000 });
    const after = (await trigger.boundingBox())!;
    expect(Math.round(after.width), `width ${before.width} -> ${after.width}`).toBe(Math.round(before.width));
    expect(Math.round(after.height), `height ${before.height} -> ${after.height}`).toBe(Math.round(before.height));
  });

  test("i pannelli dello stato si aprono COME dropdown, e la colonna non tocca il bordo", async ({ page }) => {
    await goToApp(page);

    const rect = (sel: string) => page.evaluate((q) => {
      const el = document.querySelector(q as string) as HTMLElement | null;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left),
               right: Math.round(r.right), vh: window.innerHeight, vw: window.innerWidth };
    }, sel);

    // 1) THE COLUMN BREATHES AT THE FOOT. The status row used to carry the
    //    bottom inset; it moved into the menu and took the padding with it,
    //    leaving the identity band flush against the edge — reported as the
    //    spacing being wrong down there. One inset on every sidebar axis.
    const column = (await rect('[aria-label="Topics sidebar"]'))!;
    const band = (await rect('[data-testid="identity-block"]'))!;
    const breathing = column.bottom - band.bottom;
    expect(breathing, `the band ends at ${band.bottom} in a column ending at ${column.bottom}`)
      .toBeGreaterThanOrEqual(4);

    // 2) THE PANELS OPEN AS DROPDOWNS: below their anchor, and on screen. They
    //    were hard-wired to grow UPWARD, which was right at the foot of a column
    //    and wrong under a menu near the top — measured with the chip at y=234,
    //    the 226px panel landed at y=2, two pixels from the ceiling.
    await page.getByTestId("sidebar-topics-menu").click();
    const chip = (await rect("[data-version-anchor]"))!;
    await page.locator("[data-version-anchor]").click();
    const popover = (await rect('[role="dialog"]'))!;
    expect(popover.top, `version popover at ${popover.top}, chip ends at ${chip.bottom}`)
      .toBeGreaterThanOrEqual(chip.bottom);
    expect(popover.top).toBeGreaterThan(0);
    expect(popover.bottom).toBeLessThanOrEqual(popover.vh);
    expect(popover.left).toBeGreaterThanOrEqual(0);
    expect(popover.right).toBeLessThanOrEqual(popover.vw);
  });
});
