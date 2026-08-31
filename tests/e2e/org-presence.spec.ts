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
 * Here we look at the pixel: the row exists, it shows the right people, and it
 * says nothing when there is nobody.
 *
 * @covers STATUSLINE-01
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
 * The minimum identity data needed for the row to be drawn at all.
 *
 * `/api/auth/session` has to say `paired`: the whole row sits behind
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
  // `status`. An invented stub would have left the row unmounted and the red
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
  // THE FRIENDS SUBJECT READS THE GRAPH, not these members any more. It used
  // to be computed from the organisation address book, which is why it was
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

test.describe("presence dell'organizzazione, a schermo", () => {
  test("PRESENCE-01: due colleghi visti ora diventano due facce sul chip dell'org", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "STATUSLINE-01" });
    const ora = Date.now();
    await stubIdentity(page, [
      membro("io", "Io", ora),          // you do not count yourself
      membro("a", "Anna", ora - 30_000),
      membro("b", "Bruno", ora - 60_000),
      membro("c", "Carla", ora - 3_600_000), // an hour ago: past the threshold
    ]);
    await page.goto("/");

    const chip = page.getByTestId("org-chip");
    await expect(chip).toBeVisible({ timeout: 20000 });
    // Presence lives INSIDE the group chip: with two organisations a single
    // count would not say which group those people belong to.
    await expect(chip.getByTestId("presence-face")).toHaveCount(2);
    // And the group name is NOT on screen: the chip holds the logo and the
    // faces, the full name lives in the panel the chip opens.
    await expect(chip).not.toContainText("Acme Group");
    await page.screenshot({ path: join(SHOTS, "presence-due.png") });
  });

  test("PRESENCE-02: da solo, il chip resta ed è il solo logo", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "STATUSLINE-01" });
    // "0 online" is noise you learn to skip: with nobody around the chip is
    // just the logo, and the emptiness is already the answer. The chip stays,
    // though, because it is also the door to managing THAT organisation.
    await stubIdentity(page, [membro("io", "Io", Date.now())]);
    await page.goto("/");
    await expect(page.getByTestId("identity-row-me")).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId("org-chip")).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId("org-chip-online")).toHaveCount(0);
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
    await expect(page.getByTestId("identity-row-me")).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId("org-chip-online")).toHaveCount(0);
  });

  test("PRESENCE-04: il chip dell'org apre il pannello, e il pannello la gestione", async ({ page }) => {
    // The chip no longer jumps to a page: it opens its panel, which answers
    // "who is in this group" on the spot. The door to management survives, at
    // the bottom of the panel, for when the question really is a big one.
    await stubIdentity(page, [membro("io", "Io", Date.now())]);
    await page.goto("/");
    const chip = page.getByTestId("org-chip");
    await expect(chip).toBeVisible({ timeout: 20000 });
    await chip.click();
    await expect(page.getByTestId("org-panel")).toBeVisible();
    await page.getByTestId("org-open-manage").click();
    // NOT the profile tab any more: the group is not part of your personal
    // page, so "manage this group" lands in Settings, on the organisation
    // page. The door is the same one, the room behind it changed.
    await expect(page.getByTestId("settings-page-organization")).toBeVisible({ timeout: 20000 });
  });

  test("PRESENCE-06: il pannello dell'org elenca ANCHE chi non è online", async ({ page }) => {
    // It is half the reason the panel gets opened: looking for somebody who is
    // not here right now. The closed chip shows the present, the list does not
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
    await page.getByTestId("org-chip").click();
    const panel = page.getByTestId("org-panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId("presence-person")).toHaveCount(2);
    await expect(panel.locator('[data-testid="presence-person"][data-online="true"]')).toHaveCount(1);
    await expect(panel).toContainText("Carla Bianchi");
  });

  test("PRESENCE-05: la riga degli amici mostra chi è online e apre gli amici", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "STATUSLINE-01" });
    const ora = Date.now();
    await stubIdentity(page, [
      membro("io", "Io", ora),
      membro("a", "Anna", ora - 30_000),
    ], "io", [
      { id: "io", displayName: "Io", isMe: true },
      { id: "a", displayName: "Anna Rossi", isMe: false },
    ], [
      // A FRIEND, and not merely a colleague: since the subject reads the
      // friendship graph, sharing a group with somebody no longer puts their
      // face on this chip. That is the whole point of the change.
      { id: "a", displayName: "Anna Rossi", lastSeenAt: ora - 30_000 },
    ]);
    await page.goto("/");

    const amici = page.getByTestId("identity-row-friends");
    await expect(amici).toBeVisible({ timeout: 20000 });
    await expect(amici).toContainText("1");
    await page.getByTestId("identity-friends-chip").click();
    await expect(page.getByTestId("friends-panel")).toBeVisible();
    await page.getByTestId("friends-open-all").click();
    await expect(page.getByTestId("profile-pane")).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId("settings-page-followers")).toBeVisible();
    await page.screenshot({ path: join(SHOTS, "amici-online.png") });
  });

  /**
   * THE BAND IS ONE BAND, MEASURED.
   *
   * What tells the three subjects apart is the first glyph of each, so the
   * three glyphs have to agree on one box and one line. They did not: on the
   * delivery screenshot of 2026-08-21 the three rows measured 16px, 8px and
   * 11px tall with the left edge jumping between x=6 and x=10, and that shot
   * was attached to the card as its evidence.
   *
   * WHAT CHANGED SINCE, AND WHY THIS TEST NOW ASSERTS THE OPPOSITE OF ONE LINE.
   * Until 8f58d75 the band was a WRAPPING inline flow, so the number of lines
   * was decided by the data: one line on a wide column with one group, three on
   * a narrow one with four. This test therefore checked the only edge that
   * survives a wrap, the left one, and it had to refuse to run below two lines
   * because with a single line there is no second start to compare. That
   * "collapsed onto one line" guard was correct then and is exactly what the
   * redesign reversed on purpose: the three subjects are now three mini-cards
   * on ONE line at every sidebar width (the name truncates, the groups past the
   * second collapse into a `+n` chip). A place whose shape moves with the data
   * is a place you re-read instead of glancing at.
   *
   * So the left-edge promise becomes a TOP promise: one line, one top. The box
   * assertion is untouched, because "same slot for every subject" is what made
   * the left edges agree by construction in the first place. The widths at
   * which the line has to hold, the contrast over the new chip veil and the
   * pointer targets are measured in `identity-chips.spec.ts`.
   *
   * It is measured on a populated app on purpose. That screenshot was taken on
   * an EMPTY one — welcome screen, sidebar blank from y=122 to y=686 — so the
   * band hung off nothing and the presence, which was the whole point, was not
   * in the picture at all.
   */
  test("PRESENCE-08: i tre glifi della fascia stanno sulla stessa riga, nella stessa scatola", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "STATUSLINE-01" });
    // SOMETHING ABOVE THE BAND. It is not needed for the measurement - the
    // glyphs sit at the bottom and do not move - but it is needed for the
    // EVIDENCE: the earlier shot was withdrawn by the verifier because it
    // showed the empty state of the app, column blank from y=122 to y=686 and
    // the band hanging off nothing. A band photographed over a deserted column
    // does not show the work.
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
    ]);
    await page.goto("/");

    const fascia = page.getByTestId("identity-block");
    await expect(fascia).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId("org-chip")).toBeVisible({ timeout: 20000 });

    // The first glyph of each subject: the face, the group mark, the people
    // mark. Their BOX is what has to match, not the ink inside it.
    const glyphs = await fascia.evaluate((el) => {
      // `identity-glyph` marks the BOX, not the ink: what has to match is the
      // slot the glyph sits in, and a stroke mark drawn at 10 inside a 14px box
      // is exactly the case a query for "the first svg" would get wrong.
      const firstGlyph = (testId: string): { x: number; y: number; w: number; h: number } | null => {
        const row = el.querySelector(`[data-testid="${testId}"]`);
        const g = row?.querySelector('[data-testid="identity-glyph"]');
        if (!g) return null;
        const r = g.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      };
      return {
        io: firstGlyph("identity-row-me"),
        org: firstGlyph("identity-row-orgs"),
        amici: firstGlyph("identity-row-friends"),
      };
    });

    expect(glyphs.io).not.toBeNull();
    expect(glyphs.org).not.toBeNull();
    expect(glyphs.amici).not.toBeNull();

    // ONE box. Sub-pixel layout rounding is the only slack allowed: anything
    // bigger is a second measurement, which is the fault this pins.
    const boxes = [glyphs.io!, glyphs.org!, glyphs.amici!];
    for (const s of boxes) {
      expect(s.w, `box width ${s.w}`).toBe(boxes[0]!.w);
      expect(s.h, `box height ${s.h}`).toBe(boxes[0]!.h);
    }

    // ONE LINE, SO ONE TOP.
    //
    // This used to read "one left edge, for whoever OPENS a line", and it
    // counted the lines first because a wrapping band could have two or three
    // of them. There is one now, by construction, so the thing worth pinning is
    // that there STILL is one: a second `y` in this set means the band went
    // back to wrapping, which is the regression the redesign was for.
    //
    // The left edge is not lost, it moved into the box assertion above: three
    // marks of the same size, opened by chips with the same padding, agree on
    // one edge without a margin tuned by hand. That is what the `-mx-1` on the
    // "me" chip used to break, starting the subject you read first at x=6
    // against everyone else's x=10.
    const tops = boxes.map((s) => s.y);
    expect(
      Math.max(...tops) - Math.min(...tops),
      `the band wrapped: glyph tops at ${tops.join(", ")}`,
    ).toBeLessThanOrEqual(1);

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

  test("PRESENCE-09: la chip dell'identita' porta i NUMERI, non la frase", async ({ page }) => {
    // The presence phrase ("3 al lavoro, 12 aperte" allow-italian: the exact
    // string the bar used to print) repeated the same three
    // words every day and truncated the name to fit them. The chip now carries
    // the digits, each behind its own glyph, and the sentence stays in the
    // tooltip: this checks the digits are the ones on screen.
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
    // THE SIDEBAR HAS TO BE WIDE, and that is not a bench detail: since
    // 6615e9eeb the presence signals live behind `@[300px]/identity`, i.e. they
    // appear only once the column has room for them. Without seeding the width
    // the test starts from the default sidebar, the box stays `hidden` by
    // design, and the red would claim "the numbers are missing" when the truth
    // is "there was no room" — two different things.
    await page.addInitScript(() => {
      const raw = localStorage.getItem("app-settings");
      const base: Record<string, unknown> = raw ? JSON.parse(raw) : {};
      localStorage.setItem("app-settings", JSON.stringify({
        ...base, sidebarWidth: 360, sidebarWidthExpanded: 360, sidebarCollapsed: false,
      }));
    });
    await page.goto("/");
    const signals = page.getByTestId("presence-summary");
    await expect(signals).toBeVisible({ timeout: 20000 });
    await expect(signals).toContainText("3");
    await expect(signals).toContainText("12");
    // No words: those cost six times the glyph and say the same thing.
    await expect(signals).not.toContainText("aperte");
    await expect(signals).not.toContainText("lavoro");
    await page.screenshot({ path: join(SHOTS, "segnali-chip.png") });
    // The review evidence, cropped to the foot of the column: a full 1280px
    // shot shown on a 268px card turns the whole band into four grey pixels.
    // The clip keeps the last rows and the bar above, which is what makes the
    // band readable as a PLACE and not as a floating widget.
    const box = await page.getByTestId("identity-block").boundingBox();
    if (box) {
      await page.screenshot({
        path: join(SHOTS, "fascia-identita.png"),
        clip: { x: 0, y: Math.max(0, box.y - 96), width: Math.round(box.width + 24), height: Math.round(box.height + 112) },
      });
    }
  });

  test("PRESENCE-07: senza nessuno la riga amici resta, dice «Amici» e zero", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "STATUSLINE-01" });
    // It used to disappear. A row that exists only when it has good news
    // leaves "but where are the friends?" unanswered for the very person who
    // has nobody yet, the only one who needs to get in to begin.
    await stubIdentity(page, [membro("io", "Io", Date.now())], "io", [
      { id: "io", displayName: "Io", isMe: true },
    ]);
    await page.goto("/");
    const amici = page.getByTestId("identity-row-friends");
    await expect(amici).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId("identity-friends-total")).toHaveText("0");
    // But it does not say so with bad news: at zero the row carries its own
    // name, not "nobody online".
    await expect(amici).toContainText("Amici");
    await expect(amici).not.toContainText("Nessuno online");
    // And the panel explains where friends come from, instead of being empty.
    await page.getByTestId("identity-friends-chip").click();
    // The panel still answers "where do these people come from", which is the
    // point of the assertion; it answers it in the friendship model now, where
    // the copy used to talk about followers.
    await expect(page.getByTestId("friends-panel")).toContainText("chiedile l’amicizia");
  });
  /**
   * A COLLEAGUE IS NOT A FRIEND, and the chip has to know the difference.
   *
   * This is the regression the whole change is about: before it, the third
   * subject was fed by the organisation address book, so anybody sharing a
   * group with you appeared as one of "your people". The stub here gives an
   * organisation with a member who is online and NO friendship at all: the
   * chip must say zero and show no face.
   */
  test("BAND-01: un collega online non è un amico, e il chip non lo conta", async ({ page }) => {
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

    const amici = page.getByTestId("identity-row-friends");
    await expect(amici).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId("identity-friends-total")).toHaveText("0");
    await expect(amici.getByTestId("presence-face")).toHaveCount(0);
    // The colleague is still there, in the subject that is about groups.
    await expect(page.getByTestId("org-chip").getByTestId("presence-face")).toHaveCount(1);
  });

  /**
   * A REQUEST WAITING FOR YOU IS ANSWERED WHERE YOU SEE IT.
   *
   * Sending somebody to a page to press "accept" is the round trip the panel
   * exists to remove. Closed, the chip says it with the ink of its glyph,
   * which is the only signal that costs no width on a line that has none.
   */
  test("BAND-02: una richiesta di amicizia si vede sul chip e si accetta dal pannello", async ({ page }) => {
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
    let accettata = false;
    await page.route("**/api/people/b/friend/accept", (r) => {
      accettata = true;
      return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ state: "friends" }) });
    });
    await page.goto("/");

    const glifo = page.getByTestId("identity-row-friends").getByTestId("identity-glyph");
    await expect(glifo).toHaveAttribute("data-pending", "true", { timeout: 20000 });

    await page.getByTestId("identity-friends-chip").click();
    await expect(page.getByTestId("friends-requests")).toContainText("Bruno Verdi");
    await page.getByTestId("friend-accept-b").click();
    await expect.poll(() => accettata).toBe(true);
  });

  /**
   * THE ACCOUNT PANEL, on an installation that has a service and no link.
   *
   * The two steps happen inside the dropdown: this is the whole point of the
   * change, and until it landed the only way in was three clicks deep in
   * Settings, on a page you had to already know about.
   */
  test("BAND-03: il pannello del primo chip è l'account, e da lì si accede", async ({ page }) => {
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
    let chiesto: string | null = null;
    await page.route("**/api/auth/account/code", (r) => {
      chiesto = (r.request().postDataJSON() as { email: string }).email;
      return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    });
    await page.goto("/");

    await page.getByTestId("identity-me-profile").click();
    const pannello = page.getByTestId("identity-me-panel");
    await expect(pannello).toBeVisible({ timeout: 20000 });
    // The panel says its subject, and says that nobody is signed in.
    await expect(pannello).toContainText("Account");
    await expect(pannello.getByTestId("account-line")).toContainText("Nessun account");

    await pannello.getByTestId("account-email").fill("qualcuno@example.test");
    await pannello.getByTestId("account-send-code").click();
    await expect.poll(() => chiesto).toBe("qualcuno@example.test");
    // Second step, in the same panel: the code field replaces the address one
    // and the panel never closed.
    await expect(pannello.getByTestId("account-code")).toBeVisible();
  });

  /**
   * AND WITH NO ACCOUNT SERVICE THE PANEL DOES NOT MENTION ACCOUNTS.
   *
   * The free plan is the product, not a mutilated version to apologise for in
   * a dropdown: no form, and no "not available here" either.
   */
  test("BAND-04: senza servizio degli account il pannello non ne parla", async ({ page }) => {
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

    await page.getByTestId("identity-me-profile").click();
    const pannello = page.getByTestId("identity-me-panel");
    await expect(pannello).toBeVisible({ timeout: 20000 });
    await expect(pannello.getByTestId("account-signin")).toHaveCount(0);
    // The way to your own profile stays, which is what the panel had before.
    await expect(pannello.getByTestId("identity-me-open-profile")).toBeVisible();
  });
});
