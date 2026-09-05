/**
 * SETTINGS SPEAK THE APP'S LANGUAGE, AND ORGANISATIONS CAN BE FOUND.
 *
 * Reported by whoever uses the app: the settings area does not look properly
 * split, organisations are nowhere to be seen, and the profile tab lumps in
 * adding other people, which makes no sense for a single account.
 *
 * Two distinct facts that look like one:
 *
 *  1. THE LANGUAGE. The left menu said "Appearance", "Notifications",
 *     "Profile", "Devices", "Plan": five English words inside an app running in
 *     Italian. Not a nicety: when an entry is named with a word that is not the
 *     one in your head, scanning the list fails and the conclusion is "it is not
 *     there". The repo already has a dictionary (`i18n.ts`) and settings were
 *     the one surface that did not use it.
 *  2. ORGANISATIONS ARE THERE. `IdentitySection` handles them end to end. This
 *     test finds them, so if someone buries them again at the bottom of a tab
 *     about something else, it turns red.
  * @covers SETORG-01
 */
import { test, expect } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

test.describe("Impostazioni · lingua e organizzazioni", () => {
  test.describe.configure({ timeout: 60_000 });

  test("SET-LINGUA: il menu delle impostazioni è in italiano", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "SETORG-01" });
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    await page.keyboard.press("Meta+Comma");
    const pannello = page.locator('[data-testid="settings-panel"]');
    await expect(pannello).toBeVisible({ timeout: 10000 });

    // Every menu entry, not one at random. A half-translated list is worse
    // than an untranslated one: the two halves look like different things.
    const voci = pannello.locator("nav button");
    const testi = (await voci.allInnerTexts()).map((t) => t.trim()).filter(Boolean);
    expect(testi.length, "il menu deve avere delle voci").toBeGreaterThan(3);

    // The English words that used to be here. If they come back, this bites.
    const inglesi = ["Appearance", "Notifications", "Profile", "Devices", "Plan"];
    for (const parola of inglesi) {
      expect(testi, `«${parola}» è inglese: il menu delle impostazioni è l'unica superficie dell'app che non passa dal dizionario`).not.toContain(parola);
    }
  });

  test("SET-BANNER: il banner da mettere su GitHub si copia gia' scritto", async ({ page, context }) => {
    test.info().annotations.push({ type: "spec", description: "SETORG-01" });
    // Asked for: a banner to put on a GitHub profile. The banner already
    // existed (/api/profile/banner.svg, a real SVG with real numbers), but the
    // only gesture on offer was "open": then you save it, look up the markdown
    // syntax and remember the URL. The line to paste is ONE, and the app
    // already knows it.
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    await page.keyboard.press("Meta+Comma");
    const pannello = page.locator('[data-testid="settings-panel"]');
    await expect(pannello).toBeVisible({ timeout: 10000 });
    await pannello.locator("nav button", { hasText: /^Profilo$/ }).click();

    const copia = pannello.getByTestId("profile-banner-copy");
    await expect(copia, "deve esserci un gesto per copiare il banner").toBeVisible({ timeout: 10000 });
    await copia.click();

    // What lands in the clipboard has to be VALID markdown pointing at the
    // banner: a button that copies a wrong string is worse than no button,
    // because the defect only shows up once it is pasted on GitHub.
    const appunti = await page.evaluate(() => navigator.clipboard.readText());
    expect(appunti, `negli appunti c'e' "${appunti}"`).toMatch(/^!\[[^\]]*\]\(https?:\/\/[^)]*\/api\/profile\/banner\.svg[^)]*\)$/);

    // AND IF THE ADDRESS IS NOT REACHABLE FROM OUTSIDE, IT SAYS SO.
    //
    // The banner is served by the local process: on a test install the origin
    // is `localhost`, and that markdown pasted into a README on GitHub is a
    // broken image for everybody. The gesture used to hand it over in silence,
    // so the defect surfaced only after pasting.
    const origine = new URL(page.url()).hostname;
    const locale = origine === "localhost" || origine.startsWith("127.");
    const avviso = pannello.getByTestId("profile-banner-warning");
    if (locale) {
      await expect(avviso, "da localhost il markdown NON e' condivisibile e va detto").toBeVisible({ timeout: 3000 });
      await expect(avviso).toContainText(/questo computer|indirizzo/i);
    } else {
      await expect(avviso, "da un indirizzo pubblico non serve nessun avviso").toHaveCount(0);
    }

    // And the gesture says so: without feedback you cannot tell it worked.
    await expect(copia).toHaveText(/Copiato/, { timeout: 3000 });
  });

  test("SET-ORG: le organizzazioni si trovano dalle impostazioni", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "SETORG-01" });
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    await page.keyboard.press("Meta+Comma");
    const pannello = page.locator('[data-testid="settings-panel"]');
    await expect(pannello).toBeVisible({ timeout: 10000 });

    // THE DOOR HAS ITS NAME ON IT. The criterion here has always been
    // "organisations CAN BE FOUND", not "they live on that particular screen":
    // what they lacked was not a feature but an entry saying where it leads.
    // They used to sit at the bottom of the profile tab and this case went
    // looking for them there; now they have an entry of their own, which is the
    // better answer to the same question. The label is localised, which is the
    // other half of what this file measures.
    const org = pannello.locator("nav button", { hasText: /^Organizzazione$/ });
    await expect(org, "deve esistere una voce «Organizzazione»").toBeVisible({ timeout: 5000 });
    await org.click();

    // And they really are behind it, named: an entry that opens an empty page
    // would move the problem instead of closing it.
    await expect(
      pannello.getByTestId("identity-orgs"),
      "le organizzazioni devono avere un blocco riconoscibile dietro la loro voce",
    ).toBeVisible({ timeout: 10000 });

    // And the profile entry stays, with its own subject: the two screens did
    // not merge, they split.
    const profilo = pannello.locator("nav button", { hasText: /^Profilo$/ });
    await expect(profilo, "deve esistere anche una voce «Profilo»").toBeVisible({ timeout: 5000 });
  });

  // SET-NOTIF-DISABLED: with the notifications master switch OFF, the children
  // have to be REALLY disabled (out of the tab order, Space inert, state exposed
  // to assistive tech), not merely dimmed by an `opacity/pointer-events` veil
  // that left the button togglable from the keyboard.
  test("SET-NOTIF-DISABLED: con le notifiche spente «Play sound» è disattivato", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "SETORG-01" });
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    await page.keyboard.press("Meta+Comma");
    const pannello = page.locator('[data-testid="settings-panel"]');
    await expect(pannello).toBeVisible({ timeout: 10000 });

    // Notifications section (localised label: /Notif/i covers both spellings).
    await pannello.locator("nav button", { hasText: /Notif/i }).click();

    const master = pannello.getByRole("switch", { name: "Enable notifications" });
    const playSound = pannello.getByRole("switch", { name: "Play sound" });
    await expect(master).toBeVisible({ timeout: 5000 });

    // Turn the master off if it is on (the DB default can be on).
    if ((await master.getAttribute("aria-checked")) === "true") {
      await master.click();
    }
    await expect(master).toHaveAttribute("aria-checked", "false");

    // The child is disabled: `disabled` reaches the <button role=switch>.
    await expect(playSound).toBeDisabled();
  });
});
