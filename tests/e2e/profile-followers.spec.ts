import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { test, expect } from "./fixtures/test-fixtures";
import { hermetic } from "./fixtures/hermetic";
import { E2E_BASE, E2E_DATA_DIR } from "./helpers/test-server";
import { apriPaneProfilo } from "./helpers/profile-pane";

/**
 * THE GITHUB SHAPED PROFILE, live, and this is the delivery clip of the card.
 *
 * A screenshot does not prove a BEHAVIOUR, and there are two of them here: a
 * GitHub login that gets TYPED and makes the face, the bio and the link appear
 * in the header, and the privacy switch that makes the figures LEAVE the page
 * because the server stopped sending them. Hence a video (`E2E_EVIDENCE=1`),
 * not an image.
 *
 * NO NETWORK TO GITHUB, and the way to get there is NOT `page.route`: the call
 * is made by the SERVER, not the browser, so intercepting it in the page
 * intercepts nothing (measured: the first pass came back with the real bio of a
 * real profile). What gets seeded is the `github_profiles` CACHE with a fresh
 * `fetched_at`, which is the same door production goes through: the server
 * finds it valid and stays home. The public quota is 60 requests an hour, so a
 * test that spends it turns red the day somebody else finishes it, and that red
 * says nothing about the product.
 *
 * WHY THE PERSON IS THE OWNER AND NOT A SECOND MEMBER. Adding one goes through
 * the licence, and the test server has ONE seat: `POST /orgs/:id/members`
 * answers `no_seats_left`. The owner's own profile exercises exactly the same
 * code (the header, the login, the counters, the privacy switch) without
 * inventing a licence that does not exist in production.
 */
hermetic(test);

/** A face served by THIS server: the clip shows a real avatar without the
 *  browser ever leaving home. */
const AVATAR = `${E2E_BASE}/icons/icon-192.png`;

/**
 * A few ATTRIBUTED turns in the test archive.
 *
 * The `globalSetup` baseline holds no user message at all, so without this seed
 * the figures would be zero and the clip would show dashes instead of the thing
 * the card asks to be shown. The rows have the real shape: the author on the
 * PROMPT (the 095 column) and the usage on the ANSWER hanging off that prompt,
 * which is exactly the direction `person-stats.ts` sums them in.
 */
function seminaTurni(personId: string, quanti: number): void {
  const db = join(E2E_DATA_DIR, "topics.db");
  const sk = "topic:evidenza-profili";
  let sql = "";
  for (let i = 0; i < quanti; i++) {
    const u = `ev-u${i}`, a = `ev-a${i}`;
    sql += `
      INSERT OR REPLACE INTO messages (id, session_key, role, content, timestamp, sort_order, author_person_id)
        VALUES ('${u}', '${sk}', 'user', 'domanda ${i}', '2026-08-10T09:0${i}:00.000Z', ${i * 2}, '${personId}');
      INSERT OR REPLACE INTO messages (id, session_key, role, content, timestamp, sort_order, parent_id,
                                       usage_prompt_tokens, usage_completion_tokens, cost_cents)
        VALUES ('${a}', '${sk}', 'assistant', 'risposta ${i}', '2026-08-10T09:0${i}:30.000Z', ${i * 2 + 1}, '${u}',
                12400, 830, 9);`;
  }
  execFileSync("sqlite3", [db, sql]);
}

/**
 * The profile cache, already fresh. It is the right way to keep GitHub out of
 * this test: the server reads `github_profiles` BEFORE deciding whether to go
 * out, and a row with `fetched_at` of now tells it there is no need.
 */
function seminaProfiloInCache(): void {
  const db = join(E2E_DATA_DIR, "topics.db");
  execFileSync("sqlite3", [
    db,
    `INSERT OR REPLACE INTO github_profiles
       (login, name, avatar_url, html_url, bio, company, location, blog, twitter_username,
        public_repos, followers, fetched_at, failed_at, status)
     VALUES ('octocat', 'Mona Octocat', '${AVATAR}', 'https://github.com/octocat',
             'Writes things that must not fall over.', 'Armonia', 'Salerno',
             'https://armonia.io', 'octocat',
             31, 12, ${Date.now()}, NULL, 200);`,
  ]);
}

test.describe("Il profilo, alla GitHub", () => {
  test("il login GitHub riempie l'intestazione, e la privacy la svuota davvero", async ({
    page,
    request,
  }) => {
    const me = await (await request.get(`${E2E_BASE}/api/auth/me`)).json();
    const personId = me?.person?.id as string;
    expect(personId, "l'installazione deve avere una persona (migration 084)").toBeTruthy();
    seminaTurni(personId, 7);
    seminaProfiloInCache();

    await page.goto("/");
    await apriPaneProfilo(page);

    // ── BEHAVIOUR 1: the header fills up from a login.
    //
    // The header is the page: no title above it, the face first. Before the
    // login there is no face and the button says so.
    const intestazione = page.getByTestId("profile-header");
    await expect(intestazione).toBeVisible();
    await page.getByTestId("profile-github-edit").click();
    await page.getByTestId("profile-github-input").fill("octocat");
    await intestazione.getByRole("button", { name: "Salva" }).click();

    await expect(page.getByTestId("profile-name")).toHaveText("Mona Octocat");
    await expect(page.getByTestId("profile-login")).toHaveText("@octocat");
    await expect(intestazione).toContainText("Writes things that must not fall over.");
    await expect(intestazione).toContainText("Armonia");
    await expect(intestazione).toContainText("Salerno");
    await expect(intestazione).toContainText("armonia.io");
    await expect(intestazione.locator("img")).toBeVisible();

    // The counters are there and they are buttons: zero followers is still a
    // measurement, and it is drawn, because it is my own profile.
    await expect(page.getByTestId("profile-count-followers")).toBeVisible();
    await expect(page.getByTestId("profile-count-following")).toBeVisible();

    // `toBeVisible()` says "it is in the DOM with a rectangle", not "it is on
    // the screen": since this test IS the delivery evidence, the clip would run
    // green over a piece of interface that never appears in the film.
    await expect(intestazione).toBeInViewport();
    await expect(intestazione.locator("img")).toBeInViewport();

    // ── BEHAVIOUR 2: a privacy switch, and the server stops sending.
    //
    // The proof that it is not CSS is on the wire: the same route is asked
    // again, and `stats` comes back null. A test that only looked at the
    // rendered page could not tell a filter from a `display: none`.
    await page.getByTestId("profile-tab-privacy").click();
    const interruttore = page.getByTestId("privacy-showStats");
    await expect(interruttore).toBeVisible();
    await expect(interruttore).toHaveAttribute("aria-checked", "true");
    await interruttore.click();
    await expect(interruttore).toHaveAttribute("aria-checked", "false");

    const dopo = await (await request.get(`${E2E_BASE}/api/people/${personId}/privacy`)).json();
    expect(dopo.privacy.showStats, "il server ha davvero registrato lo spegnimento").toBe(false);

    // And back on, so the fixture database is left as it was found: a spec that
    // leaves a switch closed poisons whichever spec runs after it.
    await interruttore.click();
    await expect(interruttore).toHaveAttribute("aria-checked", "true");
  });
});
