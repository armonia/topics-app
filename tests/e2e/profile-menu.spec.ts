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
import { createTopic, deleteTopic } from "./helpers/api-fixtures";
import { presenceSummary, type PresenceCounts } from "../../shared/presence-phrase";
import { attentionUpdated } from "./helpers/attention";
import { interceptWebSocket } from "./helpers/ws-helpers";

hermetic(test);

/** Opens the one door of the chrome and hands back its panel. */
async function openProfileMenu(page: Page): Promise<Locator> {
  const card = page.getByTestId("identity-me-profile");
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.click();
  const menu = page.getByTestId("profile-menu");
  await expect(menu).toBeVisible({ timeout: 10_000 });
  // The account block is a lazy chunk and can land after the panel is
  // visible, growing it by its own height (313 -> 369, measured): a height
  // read before it would blame the next level for the growth.
  await expect(menu.getByTestId("account-identity")).toBeVisible({ timeout: 10_000 });
  return menu;
}

/** The viewport box of a locator, rounded: the assertions are about which side
 *  of the panel the level is on, not about sub-pixels. */
async function box(locator: Locator): Promise<{ left: number; right: number; top: number; height: number }> {
  const b = await locator.boundingBox();
  if (!b) throw new Error("the element has no box: it is not laid out");
  return { left: Math.round(b.x), right: Math.round(b.x + b.width), top: Math.round(b.y), height: Math.round(b.height) };
}

/** `/api/auth/devices` in the route's own shape: the computer apart in
 *  `thisComputer` (the loopback caller IS it, so it is `current`), the paired
 *  devices in `devices` with `current: false`, since a loopback request carries
 *  no session cookie to match. `fromIpad` is the same answer to a request from
 *  the iPad: the computer is no longer `current`, the iPad is. */
function devicesRoute(phone: string, ipadConnected: boolean, fromIpad = false) {
  const paired = (id: string, name: string, connected: boolean, current: boolean) => ({
    id, name, role: "owner", createdAt: 1, person: null,
    lastSeenAt: 2, firstIp: null, revokedAt: null, connected, current,
  });
  return JSON.stringify({
    thisComputer: { name: "Questo computer", current: !fromIpad },
    people: [],
    devices: [paired("dev-1", phone, true, false), paired("dev-2", "iPad", ipadConnected, fromIpad)],
  });
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
    // AND NO WIDER THAN THE MENU. On a fresh install this level holds only the
    // hint on how friends arrive, and that one unwrapped sentence pulled it to
    // 441px beside a 288px menu: the level wraps it at the host's width.
    expect(child.right - child.left, `the level is ${child.right - child.left}px, the menu ${parent.right - parent.left}px`)
      .toBeLessThanOrEqual(parent.right - parent.left + 1);

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

    // A form level declares a dialog (its body holds fields), a list level a
    // menu: both open beside the row, so both are walked.
    const rows = await menu.locator('[aria-haspopup="menu"], [aria-haspopup="dialog"]').evaluateAll(
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
    await expect(page.locator('[role="menu"][data-testid$="-menu"], [role="dialog"][data-testid$="-menu"]:not([data-testid="profile-menu"])')).toHaveCount(1);
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

  test("i dispositivi sono un livello che parte dal computer, e senza telefoni non si allarga", async ({ page }) => {
    // The real test server, no stub: a fresh install on a Mac with no phone,
    // which is the state most people meet this level in.
    await goToApp(page);
    const menu = await openProfileMenu(page);
    const host = await box(menu);

    const row = menu.getByTestId("profile-menu-devices");
    await expect(row).toBeVisible({ timeout: 10_000 });
    // Nothing paired, nothing to count.
    await expect(row.getByTestId("devices-count")).toHaveCount(0);
    await row.click();
    const level = page.getByTestId("profile-menu-devices-menu");
    await expect(level).toBeVisible({ timeout: 10_000 });

    // THE DEVICE YOU ARE LOOKING FROM IS IN THE LIST. The route sends it apart
    // (`thisComputer`), and a level that read only `devices` dropped it: the
    // «From this device» row had left the account block as a duplicate of this
    // level, so the current device was then written nowhere in the menu.
    const rows = level.getByTestId("device-row");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Questo computer");
    await expect(rows.first()).toContainText("stai qui");

    // A SHORT EMPTY LINE, NOT THE SETTINGS SENTENCE, IN A LEVEL AS WIDE AS THE
    // MENU. That sentence, 130 characters on one line, pulled the level out to
    // 662px; and it promises a pairing request "here", which never shows up in
    // this level.
    await expect(level.getByTestId("devices-none")).toBeVisible();
    const own = await box(level);
    expect(own.right - own.left, `the level is ${own.right - own.left}px, the menu ${host.right - host.left}px`)
      .toBeLessThanOrEqual(host.right - host.left + 1);
    await expect(level).not.toContainText("richiesta");
  });

  test("il livello dei dispositivi elenca computer e telefoni, e si rilegge a ogni apertura", async ({ page }) => {
    let phone = "iPhone";
    let ipadConnected = false;
    await page.route("**/api/auth/devices", (r) =>
      r.fulfill({ status: 200, contentType: "application/json", body: devicesRoute(phone, ipadConnected) }));
    await goToApp(page);
    const menu = await openProfileMenu(page);

    // THE ROW KEEPS ONE LINE with a count in its tail. «Dispositivi
    // autorizzati» plus «1 connessi di 2» did not fit the 288px menu and
    // wrapped: a row 48px tall among 30px siblings.
    const row = menu.getByTestId("profile-menu-devices");
    const count = row.getByTestId("devices-count");
    await expect(count).toBeVisible({ timeout: 10_000 });
    const sibling = await box(menu.getByTestId("profile-menu-friends"));
    const own = await box(row);
    expect(own.height, `devices row ${own.height}px, friends row ${sibling.height}px`).toBe(sibling.height);

    await row.click();
    const level = page.getByTestId("profile-menu-devices-menu");
    await expect(level).toBeVisible({ timeout: 10_000 });
    // The computer first, as in Settings, and the only «you are here»: a
    // loopback request matches no paired device.
    const rows = level.getByTestId("device-row");
    await expect(rows).toHaveText([/Questo computer/, /iPhone/, /iPad/]);
    await expect(rows.first()).toContainText("stai qui");
    await expect(level.getByText("stai qui")).toHaveCount(1);
    // THE NUMBER ON THE ROW IS THE LIST IT OPENS: read off the level, not
    // written here. It counted the paired devices only, so it said «1 di 2»
    // over three rows; the computer is a row, and a connected one, since it
    // is the machine answering this very request.
    const listed = await rows.count();
    const live = await level.locator('[data-testid="device-row"][data-connected="true"]').count();
    expect(`${live}/${listed}`, "the level lists the computer, the iPhone and the iPad, two of them live").toBe("2/3");
    await expect(count).toHaveText(`${live} di ${listed} connessi`);

    // A RENAME IN SETTINGS SENDS NO EVENT, and the level shows names: it reads
    // the route again when it opens, not only when the page mounted.
    await page.keyboard.press("Escape");
    await expect(level).toBeHidden({ timeout: 10_000 });
    phone = "iPhone di Anna";
    await row.click();
    await expect(level.getByTestId("device-row").nth(1)).toContainText("iPhone di Anna", { timeout: 10_000 });

    // A PHONE CONNECTING SENDS NO EVENT EITHER, and the count sits on the row,
    // in sight before any level opens: the menu reads the route as it opens.
    await page.keyboard.press("Escape");
    await expect(level).toBeHidden({ timeout: 10_000 });
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden({ timeout: 10_000 });
    ipadConnected = true;
    const again = await openProfileMenu(page);
    await expect(again.getByTestId("devices-count")).toHaveText("3 di 3 connessi", { timeout: 10_000 });
  });

  test("dall'iPad il computer non si chiama «Questo computer», e stai qui è sull'iPad", async ({ page }) => {
    // The same route answering a request from the iPad: the computer is the
    // one the server runs on, not the one in your hand, so «this computer»
    // would be false on the very row that sits next to «you are here».
    await page.route("**/api/auth/devices", (r) =>
      r.fulfill({ status: 200, contentType: "application/json", body: devicesRoute("iPhone", true, true) }));
    await goToApp(page);
    const menu = await openProfileMenu(page);
    await menu.getByTestId("profile-menu-devices").click();
    const level = page.getByTestId("profile-menu-devices-menu");
    await expect(level).toBeVisible({ timeout: 10_000 });
    const rows = level.getByTestId("device-row");
    await expect(rows).toHaveText([/Il computer/, /iPhone/, /iPad/]);
    await expect(level).not.toContainText("Questo computer");
    await expect(rows.nth(2)).toContainText("stai qui");
    await expect(level.getByText("stai qui")).toHaveCount(1);
  });

  test("il livello della versione non segue una colonna larga, e il numero non ha un tooltip né un secondo evidenziato", async ({ page }) => {
    // The column at its widest drag: the host panel follows it, and every
    // level of names follows the host. The version level holds fixed
    // `label · value` rows, so it stops at 300 instead of stretching them apart.
    await page.addInitScript(() => {
      const raw = localStorage.getItem("app-settings");
      const settings: Record<string, unknown> = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      settings.sidebarWidth = 400;
      settings.sidebarCollapsed = false;
      localStorage.setItem("app-settings", JSON.stringify(settings));
    });
    await goToApp(page);
    const menu = await openProfileMenu(page);
    const host = await box(menu);
    expect(host.right - host.left, "the column did not widen, so this proves nothing").toBeGreaterThan(300);

    // The number carried a tooltip repeating what the level says one click away.
    const anchor = menu.locator("[data-version-anchor]");
    await expect(anchor).toBeVisible({ timeout: 10_000 });
    // Soft, so a regression of both halves reports both.
    await expect.soft(anchor).not.toHaveAttribute("title", /./);

    await menu.getByTestId("menu-version").click();
    const level = page.getByTestId("menu-version-menu");
    await expect(level).toBeVisible({ timeout: 10_000 });
    // AND NO SECOND HIGHLIGHT ON THE NUMBER. With the level open and the
    // pointer on the row, the row carries its hover and the number carried a
    // pill of its own inside it, a leftover of when the number was the
    // trigger: one row, one highlight.
    await expect.soft(anchor).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    const own = await box(level);
    const width = own.right - own.left;
    expect(width, `the version level is ${width}px`).toBeLessThanOrEqual(300);
    expect(width, `the version level is ${width}px`).toBeGreaterThanOrEqual(260);
  });

  test("nessuna riga Impostazioni né Provider, Strumenti, Calendario: il menu tiene chi sei e com'è l'app", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "SETHOME-01" });
    await goToApp(page);
    const menu = await openProfileMenu(page);

    // THE MENU KEEPS WHO YOU ARE AND HOW THE APP LOOKS (SETHOME-01). The
    // Settings row went on 02/10; on 03/10 the forms that are not the account
    // left too, each for where it is used. What this pins: no settings rows,
    // and the plan under the account, the devices after the people, the look
    // right after them.
    await expect(menu.getByTestId("topics-menu-settings")).toHaveCount(0);
    await expect(page.getByTestId("settings-panel")).toHaveCount(0);
    for (const gone of ["topics-menu-providers", "topics-menu-tools", "topics-menu-calendar", "topics-menu-nodes"]) {
      await expect(menu.getByTestId(gone)).toHaveCount(0);
    }
    for (const word of ["Provider AI", "Strumenti", "Calendario", "Impostazioni"]) {
      await expect(menu.getByRole("menuitem", { name: word, exact: true })).toHaveCount(0);
    }
    const order = await menu.locator("[data-testid]").evaluateAll((els) => els
      .map((el) => el.getAttribute("data-testid") ?? "")
      .filter((id) => [
        "account-identity", "topics-menu-plan", "profile-menu-friends", "profile-menu-devices",
        "topics-menu-appearance",
      ].includes(id)));
    expect(order).toEqual([
      "account-identity", "topics-menu-plan", "profile-menu-friends", "profile-menu-devices",
      "topics-menu-appearance",
    ]);
    // The plan says itself without opening anything.
    await expect(menu.getByTestId("topics-menu-plan-tail")).toHaveText("Gratuito", { timeout: 10_000 });
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
    const status = page.getByTestId("menu-system-status-menu");
    await expect(status).toBeVisible({ timeout: 10_000 });

    // THE NAMES ARE ONE BRANCH DEEPER THAN THEY USED TO BE. Who is working and
    // what it costs sat flat at the top of this level, the only subject without
    // a door of its own beside usage and machine, which both had one. Card
    // 4763a62b branched it, so the three doors now answer the three questions
    // the level exists for: what is RUNNING, what it has COST, what the MACHINE
    // is doing.
    await status.getByTestId("menu-system-performance").click();
    const level = page.getByTestId("menu-system-performance-menu");
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

  test("una chat in attesa del suo lavoro in background è un agente al lavoro, fra gli altri", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "BGVIS-03" });
    // No turn open, but the last one left an agent running: the route says
    // `background`, and that work holds a CLI in RAM right now.
    const chat = await createTopic(request, "E2E Background Agent");
    // The installation as the presence route counts it at that instant: open
    // chats, and NONE at work, because by the route's own rule a session with
    // background work only is no open stream.
    const presence: PresenceCounts = { openSessions: 12, workingSessions: 0, activeTasks: 0, focusProject: null };
    try {
      await page.route("**/api/system/presence", (r) =>
        r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(presence) }));
      await page.route("**/api/topics/streaming", (r) =>
        r.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            sessions: [{
              topicId: chat.id, sessionKey: `k-${chat.id}`, state: "background",
              tasks: [{ type: "local_agent", description: "Verifica build" }], lastSignalAt: Date.now(),
            }],
          }),
        }));

      // The state `working` with its task comes from the attention state
      // (notifications-redesign, one state since 2026-10-04): staged as the
      // server writes it, after the snapshot of the socket, which replaces
      // whatever came before.
      const ws = await interceptWebSocket(page, /\/ws(?:\?|$)/);
      await goToApp(page);
      await expect.poll(() => ws.getByType("attention:init").length, { timeout: 15_000 }).toBeGreaterThan(0);
      ws.send(attentionUpdated(`topic:${chat.id}`, {
        state: "working",
        background: [{ id: "agent-1", kind: "agent", label: "Verifica build", startedAt: new Date().toISOString() }],
      }));
      const badge = page.getByTestId("identity-agents-badge").locator("[data-notification-count]");
      await expect(badge).toHaveAttribute("data-notification-count", "1", { timeout: 20_000 });
      // THE CARD'S TOOLTIP says the badge's number too. Composed from the
      // route's working count it read "no agent at work" beside a badge
      // reading 1: the same number and its text disagreeing, one hover apart.
      // Built with the phrase's own function, so no wording is frozen here.
      const card = page.getByTestId("identity-me-profile");
      await expect.poll(() => card.getAttribute("title"), { timeout: 20_000 })
        .toContain(presenceSummary({ ...presence, workingSessions: 1 }, "it"));
      expect(await card.getAttribute("title")).not.toContain(presenceSummary(presence, "it"));

      const menu = await openProfileMenu(page);
      // The working digit in the tail of the system row is the badge's number,
      // from the same rows (BGVIS-03), and it says it with the badge's own
      // sentence.
      const tailWorking = menu.getByTestId("presence-summary").locator('[data-signal="working"]');
      await expect(tailWorking).toHaveText("1", { timeout: 10_000 });
      const badgeTitle = await badge.getAttribute("title");
      expect(badgeTitle, "the badge carries its sentence").toBeTruthy();
      await expect(tailWorking).toHaveAttribute("title", badgeTitle!);
      await menu.getByTestId("menu-system-status").click();
      const status = page.getByTestId("menu-system-status-menu");
      await expect(status).toBeVisible({ timeout: 10_000 });
      await status.getByTestId("menu-system-performance").click();
      const level = page.getByTestId("menu-system-performance-menu");
      await expect(level).toBeVisible({ timeout: 10_000 });

      // One row per chat, among the working ones: a job it waits for is work.
      const rows = level.getByTestId("active-agent-row");
      await expect(rows).toHaveCount(1);
      await expect(rows.first()).toContainText("E2E Background Agent");
      // The number on the card and the digit in the tail are the rows they summarise.
      const listed = String(await rows.count());
      await expect(badge).toHaveAttribute("data-notification-count", listed);
      await expect(tailWorking).toHaveText(listed);
    } finally {
      await deleteTopic(request, chat.id).catch(() => {});
    }
  });
});
