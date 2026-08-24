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
async function stubIdentita(
  page: Page,
  membri: ReturnType<typeof membro>[],
  ioId = "io",
  rubrica: Array<{ id: string; displayName: string; isMe: boolean }> = [{ id: "io", displayName: "Io", isMe: true }],
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
}

test.describe("presence dell'organizzazione, a schermo", () => {
  test("PRESENCE-01: due colleghi visti ora diventano due facce sul chip dell'org", async ({ page }) => {
    const ora = Date.now();
    await stubIdentita(page, [
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
    // "0 online" is noise you learn to skip: with nobody around the chip is
    // just the logo, and the emptiness is already the answer. The chip stays,
    // though, because it is also the door to managing THAT organisation.
    await stubIdentita(page, [membro("io", "Io", Date.now())]);
    await page.goto("/");
    await expect(page.getByTestId("identity-row-me")).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId("org-chip")).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId("org-chip-online")).toHaveCount(0);
  });

  test("PRESENCE-03: un membro senza dispositivi vivi vale null, non il 1970", async ({ page }) => {
    // `lastSeenAt: null` means "unknown", and when sorting by last seen a zero
    // would end up at the bottom together with people who really were here. A
    // null read as 0 would not change the count, but a `null` treated as a date
    // would: this checks it never enters the count.
    await stubIdentita(page, [
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
    await stubIdentita(page, [membro("io", "Io", Date.now())]);
    await page.goto("/");
    const chip = page.getByTestId("org-chip");
    await expect(chip).toBeVisible({ timeout: 20000 });
    await chip.click();
    await expect(page.getByTestId("org-panel")).toBeVisible();
    await page.getByTestId("org-open-manage").click();
    await expect(page.getByTestId("profile-pane")).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId("settings-page-organization")).toBeVisible();
  });

  test("PRESENCE-06: il pannello dell'org elenca ANCHE chi non è online", async ({ page }) => {
    // It is half the reason the panel gets opened: looking for somebody who is
    // not here right now. The closed chip shows the present, the list does not
    // stop there.
    const ora = Date.now();
    await stubIdentita(page, [
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
    const ora = Date.now();
    await stubIdentita(page, [
      membro("io", "Io", ora),
      membro("a", "Anna", ora - 30_000),
    ], "io", [
      { id: "io", displayName: "Io", isMe: true },
      { id: "a", displayName: "Anna Rossi", isMe: false },
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
   * three glyphs have to start on the same vertical line. They did not: on the
   * delivery screenshot of 2026-08-21 the three rows measured 16px, 8px and
   * 11px tall with the left edge jumping between x=6 and x=10, and that shot
   * was attached to the card as its evidence.
   *
   * It is measured on a populated app on purpose. That screenshot was taken on
   * an EMPTY one — welcome screen, sidebar blank from y=122 to y=686 — so the
   * band hung off nothing and the presence, which was the whole point, was not
   * in the picture at all.
   */
  test("PRESENCE-08: i tre glifi della fascia partono dalla stessa riga verticale", async ({ page, request }) => {
    // SOMETHING ABOVE THE BAND. It is not needed for the measurement - the
    // glyphs sit at the bottom and do not move - but it is needed for the
    // EVIDENCE: the earlier shot was withdrawn by the verifier because it
    // showed the empty state of the app, column blank from y=122 to y=686 and
    // the band hanging off nothing. A band photographed over a deserted column
    // does not show the work.
    const seminati: string[] = [];
    for (const nome of ["Rilascio", "Anteprime", "Presenza"]) {
      const t = await createTopic(request, `${nome} ${Date.now()}`);
      seminati.push(t.id);
    }

    const ora = Date.now();
    await stubIdentita(page, [
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
    const glifi = await fascia.evaluate((el) => {
      // `identity-glyph` marks the BOX, not the ink: what has to match is the
      // slot the glyph sits in, and a stroke mark drawn at 10 inside a 14px box
      // is exactly the case a query for "the first svg" would get wrong.
      const primo = (testId: string): { x: number; y: number; w: number; h: number } | null => {
        const riga = el.querySelector(`[data-testid="${testId}"]`);
        const g = riga?.querySelector('[data-testid="identity-glyph"]');
        if (!g) return null;
        const r = g.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      };
      return {
        io: primo("identity-row-me"),
        org: primo("identity-row-orgs"),
        amici: primo("identity-row-friends"),
      };
    });

    expect(glifi.io).not.toBeNull();
    expect(glifi.org).not.toBeNull();
    expect(glifi.amici).not.toBeNull();

    // ONE box. Sub-pixel layout rounding is the only slack allowed: anything
    // bigger is a second measurement, which is the fault this pins.
    const scatole = [glifi.io!, glifi.org!, glifi.amici!];
    for (const s of scatole) {
      expect(s.w, `box width ${s.w}`).toBe(scatole[0]!.w);
      expect(s.h, `box height ${s.h}`).toBe(scatole[0]!.h);
    }

    // ONE LEFT EDGE, for whoever OPENS a line.
    //
    // The band is a wrapping inline flow, not three stacked rows: with a wide
    // enough sidebar the groups share the line with "me" and only start their
    // own when they no longer fit. So the edge is a promise about who begins a
    // line, and that is what is checked here — "me" and "friends" measured on
    // different lines (y=728 and y=751), while the groups sit at x=203 on the
    // first line because they are its continuation, not its start.
    //
    // It was broken for the subject you read first: the "me" chip carried a
    // `-mx-1` that no other did, so it began at x=6 against x=10.
    const perRiga = new Map<number, number[]>();
    for (const s of scatole) perRiga.set(s.y, [...(perRiga.get(s.y) ?? []), s.x]);
    const inizi = [...perRiga.values()].map((xs) => Math.min(...xs));
    expect(inizi.length, "the band collapsed onto one line: nothing to compare").toBeGreaterThan(1);
    expect(Math.max(...inizi) - Math.min(...inizi)).toBeLessThanOrEqual(1);

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
      const larghezza = 1000;
      const altezza = Math.min(680, Math.round(larghezza * 0.66));
      await page.screenshot({
        path: join(SHOTS, "fascia-card.png"),
        clip: { x: 0, y: Math.max(0, Math.round(box.y + box.height + 24 - altezza)), width: larghezza, height: altezza },
      });
    }

    for (const id of seminati) await deleteTopic(request, id).catch(() => {});
  });

  test("PRESENCE-09: la chip dell'identita' porta i NUMERI, non la frase", async ({ page }) => {
    // The presence phrase ("3 al lavoro, 12 aperte" allow-italian: the exact
    // string the bar used to print) repeated the same three
    // words every day and truncated the name to fit them. The chip now carries
    // the digits, each behind its own glyph, and the sentence stays in the
    // tooltip: this checks the digits are the ones on screen.
    const ora = Date.now();
    await stubIdentita(page, [
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
    const segnali = page.getByTestId("presence-summary");
    await expect(segnali).toBeVisible({ timeout: 20000 });
    await expect(segnali).toContainText("3");
    await expect(segnali).toContainText("12");
    // No words: those cost six times the glyph and say the same thing.
    await expect(segnali).not.toContainText("aperte");
    await expect(segnali).not.toContainText("lavoro");
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

  test("PRESENCE-09: la chip dell'identita' porta i NUMERI, non la frase", async ({ page }) => {
    // The presence phrase ("3 al lavoro, 12 aperte" allow-italian: the exact
    // string the bar used to print) repeated the same three
    // words every day and truncated the name to fit them. The chip now carries
    // the digits, each behind its own glyph, and the sentence stays in the
    // tooltip: this checks the digits are the ones on screen.
    const ora = Date.now();
    await stubIdentita(page, [
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
    const segnali = page.getByTestId("presence-summary");
    await expect(segnali).toBeVisible({ timeout: 20000 });
    await expect(segnali).toContainText("3");
    await expect(segnali).toContainText("12");
    // No words: those cost six times the glyph and say the same thing.
    await expect(segnali).not.toContainText("aperte");
    await expect(segnali).not.toContainText("lavoro");
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

  test("PRESENCE-07: senza nessuno la riga amici resta, dice «Persone» e zero", async ({ page }) => {
    // It used to disappear. A row that exists only when it has good news
    // leaves "but where are the friends?" unanswered for the very person who
    // has nobody yet, the only one who needs to get in to begin.
    await stubIdentita(page, [membro("io", "Io", Date.now())], "io", [
      { id: "io", displayName: "Io", isMe: true },
    ]);
    await page.goto("/");
    const amici = page.getByTestId("identity-row-friends");
    await expect(amici).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId("identity-friends-total")).toHaveText("0");
    // But it does not say so with bad news: at zero the row carries its own
    // name, not "nobody online".
    await expect(amici).toContainText("Persone");
    await expect(amici).not.toContainText("Nessuno online");
    // And the panel explains where the people come from, instead of being empty.
    await page.getByTestId("identity-friends-chip").click();
    await expect(page.getByTestId("friends-panel")).toContainText("organizzazioni");
  });
});
