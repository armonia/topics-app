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
  // The WHOLE shape of a person, `stats` included. A half stub is not a smaller
  // stub, it is a different server: the friends page reads `stats.prompts`, and
  // a person without stats took the pane down to its error screen while the
  // test was blaming the deep link.
  await page.route("**/api/people", (r) =>
    r.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({
        people: rubrica.map((p) => ({
          email: null,
          githubLogin: null,
          github: null,
          stats: { prompts: 0, inputTokens: 0, outputTokens: 0, costCents: 0, ultimoPrompt: null },
          ...p,
          ...(p.isMe ? { id: ioId } : {}),
        })),
      }) }));
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
    await expect(page.getByTestId("settings-page-friends")).toBeVisible();
    await page.screenshot({ path: join(SHOTS, "amici-online.png") });
  });

  test("PRESENCE-07: senza nessuno la riga amici resta, dice «Amici» e zero", async ({ page }) => {
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
    await expect(amici).toContainText("Amici");
    await expect(amici).not.toContainText("Nessuno online");
    // And the panel explains where the people come from, instead of being empty.
    await page.getByTestId("identity-friends-chip").click();
    await expect(page.getByTestId("friends-panel")).toContainText("organizzazioni");
  });
});
