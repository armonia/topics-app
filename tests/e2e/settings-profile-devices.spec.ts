/**
 * "Who you are" and "what machines you have" are two surfaces, and both doors
 * actually lead there.
 *
 * The original work (6134a25e) split one single entry in two: `SectionId` said
 * `devices` while the label said "Profile". Since `sidebar-menu-settings` the
 * two answers left the Settings panel altogether: who you are is the Profile
 * tab, the machines are the Devices level of the user menu, and since
 * `menu-utente-tutto` there is no Settings panel at all: ⌘, opens the user
 * menu. What is defended here is what a regression would break first: the
 * menu has no Settings row to send you elsewhere, the two surfaces show
 * DIFFERENT content, and the two deep links each land on their own one.
 *
 * The active surface is read from the accessibility marks it already writes
 * (`aria-expanded` on the level's row, the profile page itself).
 *
 * @covers APPSET-03
 */
import { test, expect, type Page } from "@playwright/test";
import { join } from "node:path";
import { hermetic, resetToBaseline } from "./fixtures/hermetic";
import { openOwnProfile, openUserMenuLevel, requestUserMenuLevel } from "./helpers/user-menu";

// The boundary between this file and the previous one: without it this spec
// inherits whatever the tests before it left behind in the shared DB.
hermetic(test);

const SHOTS = "test-results/settings";

/**
 * Cmd+comma opens the user menu, the one home of every setting.
 *
 * THE WAIT BEFORE THE KEYSTROKE is not ceremony. The shortcut is listened for
 * by an effect of the mounted app, so a keypress sent to a freshly loaded
 * document falls into the void and the test turns flaky (observed: first
 * attempt red, retry green). What we wait for is a LIVE piece of the app and
 * not a fixed delay, and the key is pressed again until the panel is there:
 * that way the proof depends on the app being ready and not on how loaded the
 * machine happens to be.
 */
async function apriImpostazioni(page: Page) {
  // A LIVE piece of the app: the sidebar. It used to be the identity row,
  // which is not in the sidebar any more (card a035f945 moved it into the
  // Profile tab): waiting for it here made the wait fail for a reason that has
  // nothing to do with the panel this file is about.
  await expect(page.locator('[aria-label="Topics sidebar"]')).toBeVisible({ timeout: 20000 });
  const pannello = page.getByTestId("profile-menu");
  await expect(async () => {
    await page.keyboard.press("Meta+Comma");
    await expect(pannello).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 20000 });
  return pannello;
}

test.describe("Impostazioni: profilo e dispositivi sono due domande", () => {
  test("SETTINGS-01: ⌘, apre il menu utente, senza una riga Impostazioni, e i Dispositivi sono un suo livello", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "APPSET-03" });
    await page.goto("/");
    const menu = await apriImpostazioni(page);
    await expect(page.getByTestId("settings-panel")).toHaveCount(0);
    await expect(menu.getByTestId("topics-menu-settings")).toHaveCount(0);
    await expect(menu.getByTestId("profile-menu-devices")).toBeVisible();
    await page.screenshot({ path: join(SHOTS, "settings-due-voci.png") });
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(await openUserMenuLevel(page, "devices")).toBeVisible();
  });

  test("SETTINGS-02: le due superfici mostrano contenuti diversi", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "APPSET-03" });
    // Two labels over the SAME content would be the earlier flaw with one extra
    // name on it: the proof they are separate is what sits inside them.
    await page.goto("/");
    const dispositivi = await (await openUserMenuLevel(page, "devices")).innerText();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    const profilo = await (await openOwnProfile(page)).innerText();
    expect(profilo).not.toBe(dispositivi);
  });

  test("SETTINGS-03: il vecchio collegamento ai dispositivi apre i DISPOSITIVI, non il profilo", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "APPSET-03" });
    // THIS is the original bug: two different doors opening onto the same
    // room. The door that said «devices» now lands on the user menu with the
    // Devices level open, and nowhere near the profile.
    // SETTINGS-02 opened the Profile tab, and its saved layout comes back on
    // the next load (seen red in a batch run): start from the baseline so «no
    // profile» measures this door and not the test before.
    await resetToBaseline();
    await page.route("**/api/auth/session", (r) =>
      r.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ paired: true, as: "loopback", name: "Questo computer",
                               role: "owner", personId: "io" }) }));
    // THE SHAPE IS THE ROUTE'S REAL ONE, the computer apart in `thisComputer`:
    // a stub poorer than the server crashed the whole app once.
    await page.route("**/api/auth/devices", (r) =>
      r.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({
          thisComputer: { name: "Questo computer", current: true },
          people: [],
          devices: [{
            id: "dev-1", name: "iPhone di prova", createdAt: 1, lastSeenAt: 2,
            firstIp: null, revokedAt: null, connected: true, current: false,
            role: "owner", person: null,
          }],
        }) }));
    await page.goto("/");

    const level = await requestUserMenuLevel(page, "devices");
    await expect(page.getByTestId("profile-menu-devices"), "il collegamento deve aprire i DISPOSITIVI")
      .toHaveAttribute("aria-expanded", "true");
    await expect(level.getByTestId("device-row")).toHaveText([/Questo computer/, /iPhone di prova/]);
    await expect(page.getByTestId("settings-panel")).toHaveCount(0);
    await expect(page.getByTestId("self-profile"), "…e NON il profilo: sono due domande diverse").toHaveCount(0);
    await page.screenshot({ path: join(SHOTS, "settings-deeplink-devices.png") });
  });

  test("SETTINGS-04: dalla riga d'identità si arriva al pane Profilo", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "APPSET-03" });
    // The other half of the same decision: the row talks about you, so it leads
    // where you go to look at who you are. Before, nothing led there at all,
    // and the profile could only be found from the "Topics" menu.
    //
    // THE PATH IS ONE CLICK LONGER THAN IT WAS, on purpose. The row used to
    // jump straight to the pane; now it opens its own panel, which answers the
    // small questions on the spot and keeps the door to the page at its foot
    // (the rule is written in the identity block: every chip opens its panel).
    // This test follows the door where it went — it does not ask the row to go
    // back to being a shortcut.
    await page.route("**/api/auth/session", (r) =>
      r.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ paired: true, as: "loopback", name: "Questo computer",
                               role: "owner", personId: "io" }) }));
    await page.goto("/");

    const io = page.getByTestId("identity-me-profile");
    await expect(io).toBeVisible({ timeout: 20000 });
    await io.click();

    const porta = page.getByTestId("account-identity");
    await expect(porta).toBeVisible({ timeout: 20000 });
    await porta.click();

    await expect(page.getByTestId("profile-pane")).toBeVisible({ timeout: 20000 });
    // AND SHOWING WHO YOU ARE, which is what the door promised.
    //
    // This used to read «and on the right page: the pane has three», and it
    // checked the profile TAB of the strip. The strip is gone: the pane became
    // ONE page with followers and privacy as dropdowns off the header (card
    // b7a2c14c, landed 2026-09-01), so «the right one of three» is a question
    // with no subject left. What survives is the property the sentence was
    // really defending — the door lands on YOUR profile, not on an empty pane
    // and not on somebody else's — and `self-profile` is the element that
    // answers it now.
    await expect(page.getByTestId("self-profile")).toBeVisible({ timeout: 20000 });
  });
});
