/**
 * Organisation presence, SEEN.
 *
 * The original work (05455772) had six tests on the pure function and one
 * integration test on the route, and it passed all of them. None of the seven
 * looked at the screen: the function could count, the route could answer, and
 * had the number never reached anybody's eyes they would have stayed green all
 * the same. That is the commonest way a feature comes out "done" and is not
 * there.
 *
 * Here we look at the pixel: the people are listed, the right ones are marked
 * as here, and nothing is said when there is nobody.
 *
 * WHERE THE PIXEL IS NOW. The groups used to be a chip on the band at the foot
 * of the column, with faces on it and a panel of their own. The band is two
 * things now, the friends who are here and ONE card (STATUSLINE-04), and the
 * groups are a section of the menu that card opens: the row says how many are
 * online, expanding it lists who, and the door to managing the group is at the
 * bottom of the section. The truths this file checks did not move; the place
 * they are read from did.
 *
 * @covers STATUSLINE-01, STATUSLINE-04
 */
import { test, expect, type Page } from "@playwright/test";
import { join } from "node:path";
import { hermetic } from "./fixtures/hermetic";
import { createTopic, deleteTopic } from "./helpers/api-fixtures";

// The border between this file and the previous one: without it, this spec
// inherits whatever the tests before it left in the shared DB.
hermetic(test);

const SHOTS = "test-results/presence";

/** A member as the route sends it: raw milliseconds, not a boolean. */
function membro(id: string, name: string, lastSeenAt: number | null) {
  return { id, name, email: `${id}@example.test`, role: "member", lastSeenAt };
}

/**
 * The minimum identity data needed for the card to be drawn at all.
 *
 * `/api/auth/session` has to say `paired`: the whole band sits behind
 * `session.status !== 'paired'`, which returns null, so on an installation with
 * no pairing there is no presence regardless of the members.
 */
async function stubIdentity(
  page: Page,
  membri: ReturnType<typeof membro>[],
  ioId = "io",
  rubrica: Array<{ id: string; displayName: string; isMe: boolean }> = [{ id: "io", displayName: "Io", isMe: true }],
  amici: Array<{ id: string; displayName: string; lastSeenAt: number | null }> = [],
) {
  // The shape is the REAL one of the route (`refreshSession` in
  // lib/auth/session.ts): `paired` plus `as` plus `name`, not an already chewed
  // `status`. An invented stub would have left the card unmounted and the red
  // would have blamed the presence instead of the fake server.
  await page.route("**/api/auth/session", (r) =>
    r.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ paired: true, as: "loopback", name: "Questo computer",
                             role: "owner", personId: ioId }) }));
  await page.route("**/api/auth/devices", (r) =>
    r.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ devices: [{ connected: true, revokedAt: null }] }) }));
  await page.route("**/api/auth/orgs", (r) =>
    r.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ orgs: [{ id: "org1", name: "Acme Group", installation: true }] }) }));
  // The address book: this is where the client learns who you are
  // (`useIdentityPresence`), not the session. They are two different fetches,
  // and that is exactly why `presentiOra` has to keep quiet while the identity
  // is not there yet.
  // The WHOLE shape of a person, `stats` and the follow fields included. A half
  // stub is not a smaller stub, it is a different server: the followers page
  // reads the counters, and a person without them took the pane down to its
  // error screen while the test was blaming the deep link.
  await page.route("**/api/people", (r) =>
    r.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({
        people: rubrica.map((p) => ({
          email: null,
          githubLogin: null,
          github: null,
          stats: { prompts: 0, inputTokens: 0, outputTokens: 0, costCents: 0, ultimoPrompt: null },
          counts: { followers: 0, following: 0 },
          viewerFollows: false,
          followsViewer: false,
          lastSeenAt: null,
          ...p,
          ...(p.isMe ? { id: ioId } : {}),
        })),
      }) }));
  // The followers page asks for the two lists of whoever is `isMe`. Unrouted
  // they would reach the real server, which in this stubbed world knows none of
  // these ids and answers 404: the page would then draw an empty state that has
  // nothing to do with what the test is looking at.
  await page.route("**/api/people/*/follow*", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ people: [] }) }));
  await page.route("**/api/auth/orgs/*/members", (r) =>
    r.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ members: membri }) }));
  // THE CHIPS READ THE GRAPH, not these members. The friends used to be
  // computed from the organisation address book, which is why they were
  // labelled "People": the two are stubbed apart here because they are two
  // different questions, and a test that fed one from the other could no
  // longer tell them apart.
  await page.route("**/api/friendships", (r) =>
    r.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({
        friends: amici.map((p) => ({
          email: null,
          githubLogin: null,
          github: null,
          stats: null,
          isMe: false,
          counts: null,
          viewerFollows: false,
          followsViewer: false,
          since: 0,
          ...p,
        })),
        incoming: [],
        outgoing: [],
      }) }));
}

/** Open the one door of the chrome and hand back the menu. */
async function openMenu(page: Page) {
  const card = page.getByTestId("identity-me-profile");
  await expect(card).toBeVisible({ timeout: 20000 });
  await card.click();
  const menu = page.getByTestId("profile-menu");
  await expect(menu).toBeVisible({ timeout: 10000 });
  return menu;
}

/** Open the menu and expand the organisations section. */
async function openOrgs(page: Page) {
  const menu = await openMenu(page);
  await menu.getByTestId("profile-menu-orgs").click();
  await expect(menu.getByTestId("profile-menu-orgs")).toHaveAttribute("aria-expanded", "true");
  return menu;
}

/** Open the menu and expand the friends section. */
async function openFriends(page: Page) {
  const menu = await openMenu(page);
  await menu.getByTestId("profile-menu-friends").click();
  await expect(menu.getByTestId("profile-menu-friends")).toHaveAttribute("aria-expanded", "true");
  return menu;
}

/**
 * A SHOT OF THE MENU AND OF THE CARD THAT OPENED IT, and nothing else.
 *
 * A full-page screenshot of a panel 288px wide is 95% of a window nobody is
 * looking at, and at card size it becomes an unreadable grey rectangle. The
 * clip takes the panel plus a margin, and stays wider than it is tall so the
 * board crops nothing off the bottom.
 */
async function clipShot(page: Page, panel: ReturnType<Page["getByTestId"]>, path: string) {
  const box = await panel.boundingBox();
  expect(box).not.toBeNull();
  const vh = page.viewportSize()?.height ?? 800;
  // THE PANEL IS ON SCREEN. It flips above the card by itself and caps its own
  // height; a panel past either edge is a wrong panel, and the shot would be
  // a picture of the wrong panel.
  expect(box!.y, `the menu starts at ${box!.y}`).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height, `the menu ends at ${box!.y + box!.height} in a ${vh}px window`).toBeLessThanOrEqual(vh);
  const width = Math.min(760, Math.max(660, Math.round(box!.x + box!.width + 40)));
  // Landscape when the panel allows it (a card crops the excess off the
  // BOTTOM), and as tall as the panel when it does not: the menu holds the
  // account, the people and the commands, and cropping the actions off the
  // foot of it would cut exactly the part the shot is for.
  const height = Math.min(vh, Math.max(Math.round(width * 0.66), Math.round(box!.height + 40)));
  const y = Math.max(0, Math.round(box!.y + box!.height + 20 - height));
  await page.screenshot({ path, clip: { x: 0, y, width, height } });
}

test.describe("presence dell'organizzazione, a schermo", () => {
  test("PRESENCE-01: due colleghi visti ora sono «2 di 3» sulla riga, e due persone accese nella lista", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "STATUSLINE-01" });
    const ora = Date.now();
    await stubIdentity(page, [
      membro("io", "Io", ora),          // you do not count yourself
      membro("a", "Anna", ora - 30_000),
      membro("b", "Bruno", ora - 60_000),
      membro("c", "Carla", ora - 3_600_000), // an hour ago: past the threshold
    ]);
    await page.goto("/");

    const menu = await openMenu(page);
    // The row is the headline: how many of the group are here, WITHOUT
    // counting you. Four members, three that are not you, two of them here.
    const row = menu.getByTestId("profile-menu-orgs");
    await expect(row.getByTestId("orgs-count")).toContainText("2 di 3");
    // With one organisation the row wears its name, so the count says which
    // group those people belong to.
    await expect(row).toContainText("Acme Group");
    // Expanded, the list marks the two who are here and lists the third.
    await row.click();
    await expect(menu.getByTestId("presence-person")).toHaveCount(3);
    await expect(menu.locator('[data-testid="presence-person"][data-online="true"]')).toHaveCount(2);
    await expect(menu.getByTestId("presence-person")).not.toContainText(["Io"]);
    await clipShot(page, menu, join(SHOTS, "presence-due.png"));
  });

  test("PRESENCE-02: da solo, la riga resta e dice zero senza rumore", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "STATUSLINE-01" });
    // "0 online" is what the row says when nobody is around, and it stays,
    // because it is also the door to managing THAT organisation. What must
    // not happen is a person being counted: you are the only member, and the
    // list under the row is empty rather than a list of one.
    await stubIdentity(page, [membro("io", "Io", Date.now())]);
    await page.goto("/");
    const menu = await openOrgs(page);
    await expect(menu.getByTestId("orgs-count")).toContainText("0 di 0");
    await expect(menu.getByTestId("presence-person")).toHaveCount(0);
    await expect(menu.locator('[data-testid="presence-person"][data-online="true"]')).toHaveCount(0);
  });

  test("PRESENCE-03: un membro senza dispositivi vivi vale null, non il 1970", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "STATUSLINE-01" });
    // `lastSeenAt: null` means "unknown", and when sorting by last seen a zero
    // would end up at the bottom together with people who really were here. A
    // null read as 0 would not change the count, but a `null` treated as a date
    // would: this checks it never enters the count.
    await stubIdentity(page, [
      membro("io", "Io", Date.now()),
      membro("a", "Anna", null),
    ]);
    await page.goto("/");
    const menu = await openOrgs(page);
    await expect(menu.getByTestId("orgs-count")).toContainText("0 di 1");
    await expect(menu.getByTestId("presence-person")).toHaveCount(1);
    await expect(menu.locator('[data-testid="presence-person"][data-online="true"]')).toHaveCount(0);
  });

  test("PRESENCE-04: la sezione dell'org apre la gestione", async ({ page }) => {
    // The section answers "who is in this group" on the spot. The door to
    // management survives, at the bottom of the section, for when the
    // question really is a big one.
    await stubIdentity(page, [membro("io", "Io", Date.now())]);
    await page.goto("/");
    const menu = await openOrgs(page);
    await menu.getByTestId("org-open-manage").click();
    // NOT the profile tab: the group is not part of your personal page, so
    // "manage this group" lands in Settings, on the organisation page.
    await expect(page.getByTestId("settings-page-organization")).toBeVisible({ timeout: 20000 });
  });

  test("PRESENCE-06: la lista dell'org elenca ANCHE chi non è online", async ({ page }) => {
    // It is half the reason the section gets opened: looking for somebody who
    // is not here right now. The row counts the present, the list does not
    // stop there.
    const ora = Date.now();
    await stubIdentity(page, [
      membro("io", "Io", ora),
      membro("a", "Anna", ora - 30_000),
      membro("c", "Carla", ora - 3_600_000), // past the threshold: there, but dark
    ], "io", [
      { id: "io", displayName: "Io", isMe: true },
      { id: "a", displayName: "Anna Rossi", isMe: false },
      { id: "c", displayName: "Carla Bianchi", isMe: false },
    ]);
    await page.goto("/");
    const menu = await openOrgs(page);
    await expect(menu.getByTestId("presence-person")).toHaveCount(2);
    await expect(menu.locator('[data-testid="presence-person"][data-online="true"]')).toHaveCount(1);
    await expect(menu).toContainText("Carla Bianchi");
  });

  test("PRESENCE-05: un amico online è una chip in fondo, e il menu apre gli amici", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "STATUSLINE-04" });
    const ora = Date.now();
    await stubIdentity(page, [
      membro("io", "Io", ora),
      membro("a", "Anna", ora - 30_000),
    ], "io", [
      { id: "io", displayName: "Io", isMe: true },
      { id: "a", displayName: "Anna Rossi", isMe: false },
    ], [
      // A FRIEND, and not merely a colleague: the chips read the friendship
      // graph, so sharing a group with somebody does not put their face on
      // the band. That is the whole point of the change.
      { id: "a", displayName: "Anna Rossi", lastSeenAt: ora - 30_000 },
    ]);
    await page.goto("/");

    // ONE CHIP, HER NAME ON IT: a person who is here is drawn, not counted.
    const chips = page.getByTestId("friend-chips");
    await expect(chips).toBeVisible({ timeout: 20000 });
    await expect(chips.getByTestId("friend-chip")).toHaveCount(1);
    // The name is the last span of the chip: the first is the face, which
    // spells her initials when there is no picture.
    await expect(chips.getByTestId("friend-chip").locator("span").last()).toHaveText("Anna");
    await expect(chips.getByTestId("friend-chip")).toHaveAttribute("aria-label", "Anna Rossi");
    // And the menu says the same number, and keeps the door to the page.
    const menu = await openFriends(page);
    await expect(menu.getByTestId("friends-count")).toContainText("1 di 1");
    await menu.getByTestId("friends-open-all").click();
    await expect(page.getByTestId("profile-pane")).toBeVisible({ timeout: 20000 });
    // The profile pane stopped being a tab strip: "manage friends" opens the
    // friends DROPDOWN on the single profile page, so the surviving property is
    // that panel. `settings-page-followers` was the removed tab route.
    await expect(page.getByTestId("profile-friends-panel")).toBeVisible();
    await page.screenshot({ path: join(SHOTS, "amici-online.png") });
  });

  /**
   * THE BAND IS TWO THINGS, MEASURED: the chips above, the card below, and the
   * card as wide as the column.
   *
   * This test used to pin three glyphs to one box and one line, because the
   * band was three subjects and the fault it caught (2026-08-21) was three
   * rows of three different heights. There is one subject at the foot now,
   * the card, and the thing worth pinning is what STATUSLINE-04 says about
   * it: it spans the column (a narrower card is a chip again), the chips sit
   * ABOVE it on a single line (a chip beside the card is the old band coming
   * back), and the two do not overlap.
   *
   * It is measured on a populated app on purpose. The earlier evidence was
   * withdrawn because it showed the empty state of the app, column blank from
   * y=122 to y=686 and the band hanging off nothing. A band photographed over
   * a deserted column does not show the work.
   */
  test("PRESENCE-08: le chip stanno sopra la card, e la card è larga quanto la colonna", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "STATUSLINE-04" });
    const seeded: string[] = [];
    for (const nome of ["Rilascio", "Anteprime", "Presenza"]) {
      const t = await createTopic(request, `${nome} ${Date.now()}`);
      seeded.push(t.id);
    }

    const ora = Date.now();
    await stubIdentity(page, [
      membro("io", "Io", ora),
      membro("a", "Anna", ora - 30_000),
      membro("b", "Bruno", ora - 60_000),
    ], "io", [
      { id: "io", displayName: "Io", isMe: true },
      { id: "a", displayName: "Anna", isMe: false },
      { id: "b", displayName: "Bruno", isMe: false },
    ], [
      { id: "a", displayName: "Anna", lastSeenAt: ora - 30_000 },
      { id: "b", displayName: "Bruno", lastSeenAt: ora - 60_000 },
    ]);
    await page.goto("/");

    const fascia = page.getByTestId("identity-block");
    await expect(fascia).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId("friend-chip")).toHaveCount(2, { timeout: 20000 });

    const geometry = await fascia.evaluate((el) => {
      const rect = (q: string) => {
        const r = el.querySelector(q)?.getBoundingClientRect();
        return r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) } : null;
      };
      const cs = getComputedStyle(el);
      return {
        inner: el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
        row: rect('[data-testid="friend-chips"]'),
        card: rect('[data-testid="identity-me-profile"]'),
        chips: Array.from(el.querySelectorAll('[data-testid="friend-chip"]')).map((c) => {
          const r = c.getBoundingClientRect();
          return { x: Math.round(r.x), y: Math.round(r.y) };
        }),
      };
    });

    expect(geometry.row).not.toBeNull();
    expect(geometry.card).not.toBeNull();
    // THE CARD SPANS THE COLUMN. Sub-pixel layout rounding is the only slack.
    expect(Math.abs(geometry.card!.w - geometry.inner), `card ${geometry.card!.w}px in a ${geometry.inner}px band`).toBeLessThanOrEqual(1);
    // THE CHIPS ARE ABOVE IT, on one line.
    expect(geometry.row!.bottom, `row ends at ${geometry.row!.bottom}, card starts at ${geometry.card!.y}`).toBeLessThanOrEqual(geometry.card!.y);
    const tops = geometry.chips.map((c) => c.y);
    expect(Math.max(...tops) - Math.min(...tops), `the chip row wrapped: tops at ${tops.join(", ")}`).toBeLessThanOrEqual(1);
    // AND THEY START WHERE THE CARD STARTS: one left edge for the whole band.
    expect(Math.abs(geometry.row!.x - geometry.card!.x), `row at x=${geometry.row!.x}, card at x=${geometry.card!.x}`).toBeLessThanOrEqual(1);

    const box = await fascia.boundingBox();
    if (box) {
      await page.screenshot({
        path: join(SHOTS, "fascia-allineata.png"),
        clip: { x: 0, y: Math.max(0, box.y - 40), width: Math.round(box.width + 24), height: Math.round(box.height + 56) },
      });
      // And the shot for the CARD: the whole column, not just the crop of the
      // band. A 279px-wide crop proves the measurement but is unrecognisable as
      // a thumbnail, and a thumbnail is how this evidence gets looked at. Ratio
      // below PREVIEW_CARD_MAX_RATIO (0.70).
      const width = 1000;
      const height = Math.min(680, Math.round(width * 0.66));
      await page.screenshot({
        path: join(SHOTS, "fascia-card.png"),
        clip: { x: 0, y: Math.max(0, Math.round(box.y + box.height + 24 - height)), width, height },
      });
    }

    for (const id of seeded) await deleteTopic(request, id).catch(() => {});
  });

  test("PRESENCE-09: il menu porta i NUMERI del lavoro, non la frase", async ({ page }) => {
    // The presence phrase ("3 al lavoro, 12 aperte" allow-italian: the exact
    // string the bar used to print) repeated the same three words every day
    // and truncated the name to fit them. The digits ride on the menu's title
    // now, each behind its own glyph, and the sentence stays in the tooltip:
    // this checks the digits are the ones on screen. They left the card
    // because the card answers "what is this machine spending", and two
    // families of digits in one 240px row is the pile the redesign undid.
    const ora = Date.now();
    await stubIdentity(page, [
      membro("io", "Io", ora),
      membro("a", "Anna", ora - 30_000),
      membro("c", "Carla", ora - 3_600_000),
    ], "io", [
      { id: "io", displayName: "Io", isMe: true },
      { id: "a", displayName: "Anna Rossi", isMe: false },
      { id: "c", displayName: "Carla Bianchi", isMe: false },
    ]);
    await page.route("**/api/system/presence", (r) =>
      r.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ openSessions: 12, workingSessions: 3, activeTasks: 2, focusProject: null }) }));
    await page.goto("/");
    // NOT on the card: the card carries the machine's numbers and nothing
    // else. Asserted before opening, because after opening the menu's copy
    // is on screen and a stray one on the card would hide behind it.
    await expect(page.getByTestId("identity-me-profile")).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId("presence-summary")).toHaveCount(0);
    const menu = await openMenu(page);
    const signals = menu.getByTestId("presence-summary");
    await expect(signals).toBeVisible({ timeout: 20000 });
    await expect(signals).toContainText("3");
    await expect(signals).toContainText("12");
    // No words: those cost six times the glyph and say the same thing.
    await expect(signals).not.toContainText("aperte");
    await expect(signals).not.toContainText("lavoro");
    await page.screenshot({ path: join(SHOTS, "segnali-chip.png") });
    // The review evidence, cropped to the foot of the column and the menu
    // above it: a full 1280px shot shown on a 268px card turns the whole band
    // into four grey pixels.
    await clipShot(page, menu, join(SHOTS, "fascia-identita.png"));
  });

  test("PRESENCE-07: senza nessuno non c'è la riga delle chip, e il menu spiega da dove vengono gli amici", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "STATUSLINE-04" });
    // The row is NOT drawn at zero: it is not the only way in, so a strip
    // saying "nobody" would reserve daily space for the emptiest sentence in
    // the app. The section in the menu is where "but where are the friends?"
    // gets answered, for the very person who has nobody yet.
    await stubIdentity(page, [membro("io", "Io", Date.now())], "io", [
      { id: "io", displayName: "Io", isMe: true },
    ]);
    await page.goto("/");
    await expect(page.getByTestId("identity-me-profile")).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId("friend-chips")).toHaveCount(0);
    const menu = await openMenu(page);
    const row = menu.getByTestId("profile-menu-friends");
    // The row carries its own name and a zero, not bad news.
    await expect(row).toContainText("Amici");
    await expect(row.getByTestId("friends-count")).toContainText("0 di 0");
    await expect(row).not.toContainText("Nessuno online");
    // And expanded it explains where friends come from, instead of being empty.
    await row.click();
    await expect(menu).toContainText("chiedile l’amicizia");
  });

  /**
   * A COLLEAGUE IS NOT A FRIEND, and the band has to know the difference.
   *
   * This is the regression the whole change is about: before it, the people at
   * the foot were fed by the organisation address book, so anybody sharing a
   * group with you appeared as one of "your people". The stub here gives an
   * organisation with a member who is online and NO friendship at all: no chip
   * on the band, zero friends in the menu, and the colleague counted where
   * they belong, under the group.
   */
  test("BAND-01: un collega online non è un amico, e non è una chip", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "STATUSLINE-01" });
    const ora = Date.now();
    await stubIdentity(page, [
      membro("io", "Io", ora),
      membro("a", "Anna", ora - 30_000),
    ], "io", [
      { id: "io", displayName: "Io", isMe: true },
      { id: "a", displayName: "Anna Rossi", isMe: false },
    ], []);
    await page.goto("/");

    await expect(page.getByTestId("identity-me-profile")).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId("friend-chips")).toHaveCount(0);
    const menu = await openMenu(page);
    await expect(menu.getByTestId("friends-count")).toContainText("0 di 0");
    // The colleague is still there, in the section that is about groups.
    await expect(menu.getByTestId("orgs-count")).toContainText("1 di 1");
  });

  /**
   * A REQUEST WAITING FOR YOU IS ANSWERED WHERE YOU SEE IT.
   *
   * Sending somebody to a page to press "accept" is the round trip the menu
   * exists to remove. Closed, the friends row says it with the ink of its
   * count and a declared attribute; open, the request is a row with two
   * buttons.
   */
  test("BAND-02: una richiesta di amicizia si vede sulla riga e si accetta dal menu", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "STATUSLINE-01" });
    const ora = Date.now();
    await stubIdentity(page, [membro("io", "Io", ora)], "io", [
      { id: "io", displayName: "Io", isMe: true },
    ], []);
    // The incoming list, on top of the empty graph the helper installed.
    await page.route("**/api/friendships", (r) =>
      r.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({
          friends: [],
          incoming: [{
            id: "b", displayName: "Bruno Verdi", email: null, githubLogin: null, github: null,
            stats: null, isMe: false, counts: null, viewerFollows: false, followsViewer: false,
            lastSeenAt: null, since: ora,
          }],
          outgoing: [],
        }) }));
    let accepted = false;
    await page.route("**/api/people/b/friend/accept", (r) => {
      accepted = true;
      return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ state: "friends" }) });
    });
    await page.goto("/");

    const menu = await openMenu(page);
    await expect(menu.getByTestId("friends-count")).toHaveAttribute("data-pending", "true", { timeout: 20000 });
    await menu.getByTestId("profile-menu-friends").click();
    await expect(menu.getByTestId("friends-requests")).toContainText("Bruno Verdi");
    await clipShot(page, menu, join(SHOTS, "pannello-amici.png"));
    await menu.getByTestId("friend-accept-b").click();
    await expect.poll(() => accepted).toBe(true);
  });

  /**
   * THE ACCOUNT BLOCK, on an installation that has a service and no link.
   *
   * The two steps happen inside the menu: this is the whole point of the
   * change, and until it landed the only way in was three clicks deep in
   * Settings, on a page you had to already know about.
   */
  test("BAND-03: in testa al menu c'è l'account, e da lì si accede", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "STATUSLINE-01" });
    await stubIdentity(page, [membro("io", "Io", Date.now())], "io", [
      { id: "io", displayName: "Io", isMe: true },
    ], []);
    await page.route("**/api/auth/account", (r) =>
      r.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({
          configured: true, linked: false, accountId: null, email: null,
          personId: "io", personName: "Io", linkedAt: null,
        }) }));
    let asked: string | null = null;
    await page.route("**/api/auth/account/code", (r) => {
      asked = (r.request().postDataJSON() as { email: string }).email;
      return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    });
    await page.goto("/");

    const panel = await openMenu(page);
    // The menu says its subject, and says that nobody is signed in.
    await expect(panel).toContainText("Account");
    await expect(panel.getByTestId("account-line")).toContainText("Nessun account");

    await panel.getByTestId("account-email").fill("qualcuno@example.test");
    await panel.getByTestId("account-send-code").click();
    await expect.poll(() => asked).toBe("qualcuno@example.test");
    // Second step, in the same menu: the code field replaces the address one
    // and the menu never closed.
    await expect(panel.getByTestId("account-code")).toBeVisible();
    // Back to step one for the shot: the address field is the state that shows
    // what the menu now offers, and the code step only makes sense after it.
    await panel.getByText("Annulla").click();
    await expect(panel.getByTestId("account-email")).toBeVisible();
    await clipShot(page, panel, join(SHOTS, "pannello-account.png"));
  });

  /**
   * AND WITH NO ACCOUNT SERVICE THE MENU DOES NOT MENTION ACCOUNTS.
   *
   * The free plan is the product, not a mutilated version to apologise for in
   * a dropdown: no form, and no "not available here" either.
   */
  test("BAND-04: senza servizio degli account il menu non ne parla", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "STATUSLINE-01" });
    await stubIdentity(page, [membro("io", "Io", Date.now())], "io", [
      { id: "io", displayName: "Io", isMe: true },
    ], []);
    await page.route("**/api/auth/account", (r) =>
      r.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({
          configured: false, linked: false, accountId: null, email: null,
          personId: "io", personName: "Io", linkedAt: null,
        }) }));
    await page.goto("/");

    const panel = await openMenu(page);
    // The way to your own profile stays, which is what the panel had before.
    // Asserted FIRST: the account block is a lazy chunk, so right after the
    // menu opens it can still be empty, and a "no sign-in form" check on an
    // empty block passes without looking. Once the profile door is there the
    // block has rendered, and the absence below is a real absence.
    await expect(panel.getByTestId("identity-me-open-profile")).toBeVisible();
    await expect(panel.getByTestId("account-signin")).toHaveCount(0);
  });
});
