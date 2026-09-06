import { expect, test } from "@playwright/test";
import { goToApp } from "./helpers";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/**
 * The state lives behind ONE door, and what stays outside.
 *
 * Asked for on 2026-08-31: «it has to go inside the topics dropdown menu». For
 * a month that door was the title «Topics» at the top of the column; it is the
 * USER CARD at the foot now (STATUSLINE-04), and the reason is not a change of
 * mind about the place: the doors had become five, three chips at the foot
 * and a dropdown at the top, all leading into the same house. The desktop
 * title is a word again, no chevron and no dot; the phone keeps its title
 * button because there the column is a drawer and the card does not exist.
 *
 * The cut is not "everything inside". An ALARM is not a statistic: how much
 * memory you are using is something you look at when you go looking for it, but
 * "you are offline" behind a gesture means the app is disconnected and whoever
 * is watching does not know until they open a menu. So one dot stays on the
 * card, always in the DOM (half the suite uses that testid to know the app is
 * up), painted with the load and DECLARING the alarm when there is one.
 *
 * @covers SIDEBAR-STATUS-01
 */
test.describe("Lo stato vive dietro la card dell'utente", () => {
  test("in fondo solo le chip e la card, in alto solo la parola Topics, e la spia sulla card", async ({ page }) => {
    await goToApp(page);

    // 1) THE CARD IS THE FOOT OF THE COLUMN, and the one `metrics-total` on
    //    screen is ON it: not a strip of digits under the tree, the glance
    //    the card exists for (STATUSLINE-04). The menu's own copy is not in
    //    the DOM while the menu is closed.
    const card = page.getByTestId("identity-me-profile");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="metrics-total"]')).toHaveCount(1);
    await expect(card.getByTestId("metrics-total")).toBeVisible();
    await expect(page.locator("[data-version-anchor]")).toHaveCount(0);
    await expect(page.getByTestId("sidebar-system-menu")).toHaveCount(0);

    // 2) THE TITLE IS A WORD. No button, no chevron, no dot: the trigger and
    //    its panel exist only on the phone, and a desktop that still had them
    //    would have two doors again.
    const title = page.getByTestId("sidebar-topics-title");
    await expect(title).toBeVisible();
    await expect(title).toHaveText("Topics");
    await expect(page.getByTestId("sidebar-topics-menu")).toHaveCount(0);
    await expect(page.getByTestId("sidebar-topics-menu-panel")).toHaveCount(0);
    const titleShape = await title.evaluate((el) => ({
      tag: el.tagName.toLowerCase(),
      buttons: el.querySelectorAll("button").length,
      svgs: el.querySelectorAll("svg").length,
      dots: el.querySelectorAll('[data-testid="connection-status"]').length,
      haspopup: el.getAttribute("aria-haspopup"),
    }));
    expect(titleShape, `the title is ${JSON.stringify(titleShape)}`).toEqual({ tag: "span", buttons: 0, svgs: 0, dots: 0, haspopup: null });

    // 3) THE DOT IS ON THE CARD, in the LOWER half of the column: measured,
    //    not inferred. It moved with the door: it used to sit on the title
    //    because the title was the only thing always on screen.
    const lamp = page.getByTestId("connection-status");
    await expect(lamp).toBeVisible();
    await expect(card.getByTestId("connection-status")).toHaveCount(1);
    const where = await page.evaluate(() => {
      const s = document.querySelector('[data-testid="connection-status"]')!.getBoundingClientRect();
      const c = document.querySelector('[data-testid="identity-me-profile"]')!.getBoundingClientRect();
      const col = document.querySelector('[aria-label="Topics sidebar"]')!.getBoundingClientRect();
      return { lampY: Math.round(s.y), cardY: Math.round(c.y), halfway: Math.round(col.y + col.height / 2) };
    });
    expect(where.lampY, `the dot is at ${where.lampY}, the column's halfway at ${where.halfway}`).toBeGreaterThan(where.halfway);
    expect(where.cardY, `the card is at ${where.cardY}, the column's halfway at ${where.halfway}`).toBeGreaterThan(where.halfway);

    // 4) IT DOES NOT SHOUT WHEN ALL IS WELL: no alarm declared, no pulse.
    await expect(lamp).not.toHaveAttribute("data-alarm", "true");
    await expect(lamp).not.toHaveClass(/animate-pulse/);
    await expect(page.getByTestId("ws-connection-status")).toHaveCount(0);
  });

  test("aprendo la card ci sono i numeri e la versione; la card resta in colonna", async ({ page }) => {
    await goToApp(page);
    const card = page.getByTestId("identity-me-profile");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.click();

    // ONE MENU, and the state is IN IT, as ROWS. Asked for on 31/08: the stats
    // had to look like the dropdowns above them, one fact per row.
    const menu = page.getByTestId("profile-menu");
    await expect(menu).toBeVisible({ timeout: 10_000 });
    await expect(menu.getByTestId("sidebar-system-menu")).toBeVisible();
    // The numbers read without expanding the panel (PERFPANEL-01).
    await expect(menu.getByTestId("metrics-total")).toBeVisible();
    await expect(menu.locator("[data-version-anchor]")).toBeVisible();
    // The card did NOT move into its own menu: it is the door, and a door
    // inside the room it opens is the shape that closes on itself. Both where
    // it is NOT and where it IS are asserted: without the second check this
    // would pass with the card gone entirely.
    await expect(menu.locator('[data-testid="identity-me-profile"]')).toHaveCount(0);
    await expect(card).toBeVisible();
    // And it is the only popover on screen: one door, one panel.
    await expect(page.locator('[role="dialog"]')).toHaveCount(1);
  });

  test("la card ha UNA spia sola, e non cambia misura al click", async ({ page }) => {
    await goToApp(page);
    const card = page.getByTestId("identity-me-profile");
    await expect(card).toBeVisible({ timeout: 15_000 });

    // 1) ONE. Reported from the real UI: «I now see two dots in the trigger».
    //    There were two because the alarm lamp had been added NEXT TO
    //    `TopicsLoadDot`, which already did that job. Two dots 4px apart are not
    //    two signals: they are one signal that looks broken. Small ROUND things
    //    are counted, not testids, because the defect was precisely having two
    //    different elements that look alike. The face is round too, but it is
    //    14px, above the 12px a dot can be.
    const round = await card.evaluate((el) =>
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
    expect(round, `round things in the card: ${JSON.stringify(round)}`).toHaveLength(1);

    // 2) IT DOES NOT RESIZE. «it should not resize on click»: the old trigger
    //    narrowed under the finger that had just clicked it (measured 93.8px
    //    to 79.8px) because the dot was unmounted with the menu open. The
    //    card spans the column and keeps its size either way.
    const before = (await card.boundingBox())!;
    await card.click();
    await expect(page.getByTestId("sidebar-system-menu")).toBeVisible({ timeout: 10_000 });
    const after = (await card.boundingBox())!;
    expect(Math.round(after.width), `width ${before.width} -> ${after.width}`).toBe(Math.round(before.width));
    expect(Math.round(after.height), `height ${before.height} -> ${after.height}`).toBe(Math.round(before.height));
  });

  test("i pannelli dello stato restano a schermo, e la colonna non tocca il bordo", async ({ page }) => {
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
    //    Measured on the CARD, not on the band: the band's box runs all the
    //    way to the column edge and holds the gap INSIDE itself, as padding,
    //    so its rect touches the bottom while the ink is 6px above it. Asking
    //    the box would report zero breathing on a foot that breathes.
    await page.getByTestId("identity-me-profile").waitFor({ state: "visible", timeout: 15_000 });
    const column = (await rect('[aria-label="Topics sidebar"]'))!;
    const card = (await rect('[data-testid="identity-me-profile"]'))!;
    const breathing = column.bottom - card.bottom;
    expect(breathing, `the card ends at ${card.bottom} in a column ending at ${column.bottom}`)
      .toBeGreaterThanOrEqual(4);

    // 2) THE PANELS STAY ON SCREEN. The menu hangs off a card at the very
    //    foot of the window, so it has to flip ABOVE its anchor; the version
    //    popover opens from a row inside that menu. Neither may leave the
    //    viewport: a panel against the ceiling or past the floor is the
    //    defect measured on 31/08 (a 226px panel landing at y=2).
    await page.getByTestId("identity-me-profile").click();
    const menu = (await rect('[data-testid="profile-menu"]'))!;
    expect(menu.bottom, `the menu ends at ${menu.bottom}, the card starts at ${card.top}`).toBeLessThanOrEqual(card.top);
    expect(menu.top).toBeGreaterThanOrEqual(0);
    expect(menu.left).toBeGreaterThanOrEqual(0);
    expect(menu.right).toBeLessThanOrEqual(menu.vw);
    await page.locator("[data-version-anchor]").click();
    // The version popover is the LAST dialog on screen: it is portalled after
    // the menu it was opened from.
    const popover = (await page.locator('[role="dialog"]').last().evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left),
               right: Math.round(r.right), vh: window.innerHeight, vw: window.innerWidth };
    }))!;
    expect(await page.locator('[role="dialog"]').count(), "the version popover opens on top of the menu").toBe(2);
    expect(popover.top).toBeGreaterThanOrEqual(0);
    expect(popover.bottom).toBeLessThanOrEqual(popover.vh);
    expect(popover.left).toBeGreaterThanOrEqual(0);
    expect(popover.right).toBeLessThanOrEqual(popover.vw);
  });

  test("SIDEBAR-STATUS-01d: il fondo della colonna respira quanto i lati", async ({ page }) => {
    // THE FOOT IS READ AGAINST ITS OWN SIDES. The card is the last thing in
    // the column, so the gap under it sits next to the gap to its left and to
    // its right, and any difference between the three is visible without
    // measuring. It was 10px underneath against 6px at the sides: the band's
    // own `pb-1` plus the inset of the wrapper that holds it, one padding
    // stacked on the other. Measured on the card, not on the block: the block
    // spans the full width, so only the card carries the real gap.
    await goToApp(page);
    await page.getByTestId("identity-me-profile").waitFor({ state: "visible", timeout: 20_000 });

    const gaps = await page.evaluate(() => {
      const col = document.querySelector('[aria-label="Topics sidebar"]')!.getBoundingClientRect();
      const r = document.querySelector('[data-testid="identity-me-profile"]')!.getBoundingClientRect();
      return {
        left: r.left - col.left,
        right: col.right - r.right,
        bottom: col.bottom - r.bottom,
      };
    });

    expect(gaps.bottom).toBeGreaterThan(0);
    // Sub-pixel tolerance only: this is one CSS number on three axes, not
    // three numbers that happen to be close.
    expect(Math.abs(gaps.bottom - gaps.left), `bottom ${gaps.bottom} vs left ${gaps.left}`).toBeLessThanOrEqual(1);
    expect(Math.abs(gaps.bottom - gaps.right), `bottom ${gaps.bottom} vs right ${gaps.right}`).toBeLessThanOrEqual(1);
  });

  test("SIDEBAR-STATUS-01e: le stats sono righe, una per fatto, e si vede che si aprono", async ({ page }) => {
    // ONE FACT PER ROW, and it has to LOOK like the rows above it. The desktop
    // used to pack memory, CPU, version and a restart button into one 28px
    // strip; history and settings, two items higher up in the same menu, were
    // already full-width rows. Asserted on the geometry, not on class names:
    // each row spans the menu's width and starts where the others start, which
    // is what "one per row" means when you look at it.
    await goToApp(page);
    await page.getByTestId("identity-me-profile").click();
    await expect(page.getByTestId("sidebar-system-menu")).toBeVisible({ timeout: 10_000 });

    const rows = await page.evaluate(() => {
      const ids = ["menu-system-status", "menu-version", "menu-restart"];
      const history = document.querySelector('[data-testid="topics-menu-history"]')!.getBoundingClientRect();
      return ids.map((id) => {
        const el = document.querySelector(`[data-testid="${id}"]`);
        if (!el) return { id, missing: true as const };
        const r = el.getBoundingClientRect();
        return { id, missing: false as const, left: Math.round(r.left), width: Math.round(r.width), top: Math.round(r.top) };
      }).concat([{ id: "topics-menu-history", missing: false as const, left: Math.round(history.left), width: Math.round(history.width), top: Math.round(history.top) }]);
    });

    const missing = rows.filter((r) => r.missing).map((r) => r.id);
    expect(missing, `rows missing from the menu: ${missing.join(", ")}`).toHaveLength(0);
    const present = rows as Array<{ id: string; left: number; width: number; top: number }>;
    const history = present.find((r) => r.id === "topics-menu-history")!;
    for (const row of present) {
      expect(row.left, `${row.id} starts at ${row.left}, history at ${history.left}`).toBe(history.left);
      expect(row.width, `${row.id} is ${row.width}px wide, history is ${history.width}px`).toBe(history.width);
    }
    // STACKED, not side by side: every row on its own line, in this order.
    const stats = present.filter((r) => r.id !== "topics-menu-history");
    for (let i = 1; i < stats.length; i++) {
      expect(stats[i].top, `${stats[i].id} at ${stats[i].top} vs ${stats[i - 1].id} at ${stats[i - 1].top}`)
        .toBeGreaterThan(stats[i - 1].top);
    }

    // AND BELOW THE COMMANDS, which is the half nobody was asserting: the rect
    // of «Cronologia» was read and then only its left and width were used, so
    // moving the whole block above the commands left all six tests green. The
    // reading order is the requirement — above, the things that DO something;
    // below, the things that SAY — and a menu that opens with a report makes
    // you hunt for the commands underneath the report.
    for (const row of stats) {
      expect(row.top, `${row.id} at ${row.top} must sit below «Cronologia» at ${history.top}`)
        .toBeGreaterThan(history.top);
    }
  });

  test("SIDEBAR-STATUS-01f: quando il collegamento cade, la spia lo DICHIARA", async ({ page }) => {
    // THE ALARM IS THE REASON THE TWO DOTS BECAME ONE, and until now no test
    // could see it lit: `data-alarm` was asserted once and in the NEGATIVE
    // (all well), and `ws-connection-status` once and in the negative (after
    // reconnecting). Two guards saying "it is not here now" do not prove it
    // knows how to appear.
    //
    // The WS never connects: every attempt is closed in the client's face,
    // which is the state the requirement describes.
    await page.routeWebSocket(/\/ws/, (ws) => { ws.close(); });
    await goToApp(page);

    const lamp = page.getByTestId("connection-status");
    await expect(lamp).toBeVisible({ timeout: 20_000 });
    // 1) THE DOT DECLARES IT, as an attribute: reading a hue back out of a
    //    pixel means asserting the palette instead of the state. And it is
    //    the dot ON THE CARD, with the menu closed: nobody opened anything.
    await expect(lamp).toHaveAttribute("data-alarm", "true", { timeout: 20_000 });
    await expect(lamp).toHaveClass(/animate-pulse/);
    await expect(page.getByTestId("identity-me-profile").getByTestId("connection-status")).toHaveCount(1);
    await expect(page.getByTestId("profile-menu")).toHaveCount(0);
    // 2) AND THE ROW NAMES IT, at the foot of the column, without opening
    //    anything — the scenario in openspec/specs/topics whose own title is
    //    «l'allarme si legge senza aprire niente». allow-italian: quoted title.
    await expect(page.getByTestId("ws-connection-status")).toBeVisible({ timeout: 20_000 });
  });
});
