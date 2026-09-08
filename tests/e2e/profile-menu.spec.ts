/**
 * THE USER MENU OPENS SIDEWAYS, AND THE CARD COUNTS THE AGENTS.
 *
 * Two facts that only exist on screen, so only a browser can say whether they
 * are true.
 *
 * 1. A LEVEL IS NOT AN ACCORDION. The nested sections of this menu used to
 *    unfold IN PLACE: the row stayed where it was and a list grew under it,
 *    pushing every row below it down. With three such sections the menu became
 *    a scrolling column, and the thing you clicked was no longer where you left
 *    it. The level now opens BESIDE the row, as a second panel, and the only
 *    way to prove that is to measure the two rectangles: the sublevel starts at
 *    or past the right edge of the panel that owns it, and the panel it came
 *    from does not get taller.
 *
 * 2. THE NUMBER ON THE BUTTON IS THE LIST BEHIND IT. A badge that counts with
 *    its own rule is a badge that will one day say two while the list shows
 *    three, and whoever sees it will trust the badge. So the test does not
 *    check the badge against a constant: it opens the level and counts the
 *    rows, then asserts the badge says exactly that.
 *
 * The agents are seeded through the route the app really reads
 * (`/api/topics/streaming`, the authoritative snapshot of the chats mid-reply),
 * not by poking a store: what is being tested is the whole path from the server
 * fact to the digit on the card.
 *
 * @covers STATUSLINE-05
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { goToApp } from "./helpers";
import { createTopic } from "./helpers/api-fixtures";

hermetic(test);

/** Opens the one door of the chrome and hands back its panel. */
async function openProfileMenu(page: Page): Promise<Locator> {
  const card = page.getByTestId("identity-me-profile");
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.click();
  const menu = page.getByTestId("profile-menu");
  await expect(menu).toBeVisible({ timeout: 10_000 });
  return menu;
}

/** The viewport box of a locator, rounded: the assertions are about which side
 *  of the panel the level is on, not about sub-pixels. */
async function box(locator: Locator): Promise<{ left: number; right: number; top: number; height: number }> {
  const b = await locator.boundingBox();
  if (!b) throw new Error("the element has no box: it is not laid out");
  return { left: Math.round(b.x), right: Math.round(b.x + b.width), top: Math.round(b.y), height: Math.round(b.height) };
}

test.describe("il menu utente apre i livelli di lato", () => {
  test("un gruppo con sottolivello apre un pannello A DESTRA, e il menu non cresce", async ({ page }) => {
    await goToApp(page);
    const menu = await openProfileMenu(page);

    const row = menu.getByTestId("profile-menu-friends");
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("aria-haspopup", "menu");
    await expect(row).toHaveAttribute("aria-expanded", "false");
    const before = await box(menu);

    await row.click();
    const level = page.getByTestId("profile-menu-friends-menu");
    await expect(level).toBeVisible({ timeout: 10_000 });
    await expect(row).toHaveAttribute("aria-expanded", "true");

    // TO THE RIGHT, and measured rather than assumed. The 4px slack is the gap the placement leaves
    // between the trigger and the panel: without it this would be an assertion
    // about a constant instead of about a side.
    const parent = await box(menu);
    const child = await box(level);
    expect(
      child.left,
      `the level starts at ${child.left}, the panel that owns it ends at ${parent.right}`,
    ).toBeGreaterThanOrEqual(parent.right - 4);

    // AND NOT IN LINE: an accordion would have made the panel taller. The
    // level lives in its own portal, so the host keeps the exact height it had.
    expect(parent.height, `the panel was ${before.height} and is now ${parent.height}`).toBe(before.height);
    const inside = await level.evaluate(
      (el) => document.querySelector('[data-testid="profile-menu"]')?.contains(el) ?? true,
    );
    expect(inside, "the level is a child of the panel, so it is still an accordion").toBe(false);
  });

  test("OGNI voce con sottolivello si apre di lato, nessuna esclusa", async ({ page }) => {
    // The half that was missing. The rule held for the people and the agents,
    // while «performance and system» and «version» still opened INSIDE the
    // column: a menu where two rows out of six behave differently does not
    // have a rule, it has two habits. So the check is not on one row, it is on
    // the WHOLE menu: every row that declares a level opens it beside itself,
    // and the panel that owns it never grows.
    await goToApp(page);
    const menu = await openProfileMenu(page);
    const host = await box(menu);

    const rows = await menu.locator('[aria-haspopup="menu"]').evaluateAll(
      (els) => els.map((el) => el.getAttribute("data-testid") ?? ""),
    );
    // The five groups plus the two that used to be accordions: if this list
    // ever shrinks to the point of proving nothing, the count says so.
    expect(rows.length, `rows with a level: ${rows.join(", ")}`).toBeGreaterThanOrEqual(5);
    expect(rows, "the two former accordions are levels now").toEqual(
      expect.arrayContaining(["menu-system-status", "menu-version"]),
    );

    for (const id of rows) {
      const row = menu.getByTestId(id);
      await row.click();
      const level = page.getByTestId(`${id}-menu`);
      await expect(level, `${id} opens a level`).toBeVisible({ timeout: 10_000 });
      const child = await box(level);
      expect(child.left, `${id}: the level starts at ${child.left}, the menu ends at ${host.right}`)
        .toBeGreaterThanOrEqual(host.right - 4);
      const after = await box(menu);
      expect(after.height, `${id}: the host was ${host.height} and is now ${after.height}`).toBe(host.height);
      const inside = await level.evaluate(
        (el) => document.querySelector('[data-testid="profile-menu"]')?.contains(el) ?? true,
      );
      expect(inside, `${id}: the level is inside the panel, so it is an accordion`).toBe(false);
    }

    // AND ONE AT A TIME: walking the rows leaves one level open, not seven
    // panels stacked across the screen.
    await expect(page.locator('[role="menu"][data-testid$="-menu"]')).toHaveCount(1);
  });

  test("da tastiera: destra apre, sinistra torna indietro, Escape chiude un livello per volta", async ({ page }) => {
    await goToApp(page);
    const menu = await openProfileMenu(page);
    const row = menu.getByTestId("profile-menu-friends");
    const level = page.getByTestId("profile-menu-friends-menu");

    await row.focus();
    await page.keyboard.press("ArrowRight");
    await expect(level).toBeVisible({ timeout: 10_000 });

    await page.keyboard.press("ArrowLeft");
    await expect(level).toBeHidden({ timeout: 10_000 });
    // The way back is the row you came from: the dismissal contract restores
    // focus to the trigger, so the next arrow key keeps working.
    await expect(row).toBeFocused();

    await page.keyboard.press("ArrowRight");
    await expect(level).toBeVisible({ timeout: 10_000 });

    // ONE LEVEL PER PRESS. The first Escape closes the level and leaves the
    // menu standing; the second closes the menu. A single Escape that took
    // everything down would lose the level you were reading and the menu with it.
    await page.keyboard.press("Escape");
    await expect(level).toBeHidden({ timeout: 10_000 });
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden({ timeout: 10_000 });
    await expect(page.getByTestId("identity-me-profile")).toBeFocused();
  });

  test("le impostazioni portano dritto alla sezione, senza cercarla nel pannello", async ({ page }) => {
    await goToApp(page);
    const menu = await openProfileMenu(page);

    // The row is a LEVEL now: the sections are in it, and each one is a door
    // that lands on that page of the panel. Opening the panel and then hunting
    // for the row was two searches for one intention.
    await menu.getByTestId("topics-menu-settings").click();
    const level = page.getByTestId("topics-menu-settings-menu");
    await expect(level).toBeVisible({ timeout: 10_000 });
    await level.getByTestId("topics-menu-settings-providers").click();

    const panel = page.getByTestId("settings-panel");
    await expect(panel).toBeVisible({ timeout: 10_000 });
    // The section it landed on is the one that was asked for: the rail marks
    // the current page with `aria-current`, which is the panel's own answer to
    // "where am I" and not a class name this spec would be guessing at.
    const current = panel.locator('[aria-current="page"]');
    await expect(current).toHaveCount(1);
    await expect(current).toContainText(/Provider/i);
  });

  test("il pulsante mostra quanti agenti stanno lavorando, ed è il numero della lista", async ({ page, request }) => {
    // Two chats mid-reply, said by the route the app polls for exactly this.
    const first = await createTopic(request, "E2E Agent One");
    const second = await createTopic(request, "E2E Agent Two");
    await page.route("**/api/topics/streaming", (r) =>
      r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sessions: [
            { topicId: first.id, sessionKey: `k-${first.id}`, state: "streaming" },
            { topicId: second.id, sessionKey: `k-${second.id}`, state: "streaming" },
          ],
        }),
      }));

    await goToApp(page);

    // IN PREVIEW: the number is on the closed card, before any gesture.
    const badge = page.getByTestId("identity-agents-badge").locator("[data-notification-count]");
    await expect(badge).toBeVisible({ timeout: 20_000 });
    await expect(badge).toHaveAttribute("data-notification-count", "2", { timeout: 20_000 });

    const menu = await openProfileMenu(page);
    // ONE ROW FOR THE WORK AND ITS COST (STATUSLINE-05): «active agents» and
    // «performance» were two rows asking the same question at two zooms, so
    // the names of the sessions and the machine's numbers live in one level.
    const row = menu.getByTestId("menu-system-status");
    await expect(row).toBeVisible();
    await row.click();
    const level = page.getByTestId("menu-system-status-menu");
    await expect(level).toBeVisible({ timeout: 10_000 });

    const rows = level.getByTestId("active-agent-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText("E2E Agent");
    // The badge is not checked against a constant: it is checked against the
    // list it summarises.
    const listed = await rows.count();
    await expect(badge).toHaveAttribute("data-notification-count", String(listed));

    // EVIDENCE, one frame: the card with its digit, the open menu and the
    // level it counts. Clipped to the column that holds them, never the whole
    // page: a full-page shot is a haystack, this is the needle.
    const card = await box(page.getByTestId("identity-me-profile"));
    const host = await box(menu);
    const levelBox = await box(level);
    const top = Math.max(0, Math.min(card.top, host.top, levelBox.top) - 8);
    const bottom = Math.max(card.top + card.height, host.top + host.height, levelBox.top + levelBox.height) + 8;
    const right = Math.max(card.right, host.right, levelBox.right) + 8;
    // The frame stays wider than it is tall (height/width <= 0.70) so the
    // reviewer sees the column, not a strip of it.
    const width = Math.min(1440, Math.max(right, Math.ceil((bottom - top) / 0.7)));
    await page.screenshot({
      path: "test-results/profile-menu/badge.png",
      clip: { x: 0, y: top, width, height: bottom - top },
    });
  });
});
