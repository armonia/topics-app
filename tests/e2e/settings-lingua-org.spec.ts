/**
 * THE SETTINGS SPEAK THE USER'S LANGUAGE, AND THE ORGANISATIONS CAN BE FOUND.
 *
 * Reported, verbatim: «tutta la parte di settings ancora non le vedo ben
 * divise. Non vedo le organizzazioni. In profile vedo accorpata la possibilità
 * anche di aggiungere più persone, ma non ha senso perché io sono io e la mia
 * mail».  allow-italian: the report is the subject of this test.
 *
 * Two distinct facts that look like one:
 *
 *  1. THE LANGUAGE. The left menu said "Appearance", "Notifications",
 *     "Profile", "Devices", "Plan": five English words inside an app running in
 *     Italian. It is not a nicety: when an entry is named with a word that is
 *     not the one in your head, scanning the list fails and the conclusion is
 *     "it is not there". The repo already has a dictionary (`i18n.ts`) and
 *     Settings was the one surface not using it.
 *  2. THE ORGANISATIONS ARE THERE. `IdentitySection` handles them in full and
 *     sits inside "Profile". The test finds them, so the day somebody moves
 *     them back to the bottom of a tab about something else, it goes red.
  * @covers SETORG-01
 */
import { test, expect } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { openProfileMenu } from "./helpers/open-perf-panel";
import { openOwnProfile, openUserMenuLevel } from "./helpers/user-menu";

hermetic(test);

test.describe("Impostazioni · lingua e organizzazioni", () => {
  test.describe.configure({ timeout: 60_000 });

  test("SET-LINGUA: il menu delle impostazioni è in italiano", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "SETORG-01" });
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    // ⌘, opens the user menu: every setting is one of its levels.
    const menu = page.getByTestId("profile-menu");
    await expect(async () => {
      await page.keyboard.press("Meta+Comma");
      await expect(menu).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 20000 });

    // Le voci del menu, non una a caso: TUTTE. Una lista mezza tradotta è
    // peggio di una non tradotta, perché sembra che le due metà siano cose
    // diverse.
    const voci = menu.locator('[role="menuitem"]');
    await expect(menu.getByTestId("topics-menu-appearance")).toBeVisible();
    const testi = (await voci.allInnerTexts()).map((t) => t.trim()).filter(Boolean);
    expect(testi.length, "il menu deve avere delle voci").toBeGreaterThan(8);

    // Le parole inglesi che c'erano. Se tornano, questo morde.
    const inglesi = ["Appearance", "Notifications", "Profile", "Devices", "Plan", "Settings", "Tools", "Calendar", "Nodes", "Providers"];
    for (const parola of inglesi) {
      const found = testi.find((testo) => new RegExp(`\\b${parola}\\b`).test(testo));
      expect(found, `«${parola}» è inglese: le voci del menu passano dal dizionario`).toBeUndefined();
    }
  });

  test("SET-BANNER: il banner da mettere su GitHub si copia gia' scritto", async ({ page, context }) => {
    test.info().annotations.push({ type: "spec", description: "SETORG-01" });
    // «Ci deve potere essere il banner da mettere sul mio profilo di github.»
    // Il banner c'era gia' (/api/profile/banner.svg, SVG vero con i numeri
    // veri), ma l'unico gesto offerto era «apri»: poi tocca salvare, cercare
    // la sintassi del markdown e ricordarsi l'URL. La riga da incollare e' una
    // sola e la sa gia' l'app.
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    // The banner is in the Profile tab's «Outside Topics» panel, with the
    // figures it shows (SETORG-01: copyable, ready, from the Profile tab).
    await openOwnProfile(page, "outside");
    const pannello = page.getByTestId("profile-outside-panel");

    const copia = pannello.getByTestId("profile-banner-copy");
    await expect(copia, "deve esserci un gesto per copiare il banner").toBeVisible({ timeout: 10000 });
    await copia.click();

    // Cio' che finisce negli appunti dev'essere markdown VALIDO e puntare al
    // banner: un bottone che copia una stringa sbagliata e' peggio che non
    // averlo, perche' il difetto si scopre incollandolo su GitHub.
    const appunti = await page.evaluate(() => navigator.clipboard.readText());
    expect(appunti, `negli appunti c'e' "${appunti}"`).toMatch(/^!\[[^\]]*\]\(https?:\/\/[^)]*\/api\/profile\/banner\.svg[^)]*\)$/);

    // E SE L'INDIRIZZO NON E' RAGGIUNGIBILE DA FUORI, LO DICE.
    //
    // Il banner lo serve il processo locale: su un'installazione di prova
    // l'origine e' `localhost`, e quel markdown incollato in un README su
    // GitHub e' un'immagine rotta per chiunque. Il gesto lo consegnava in
    // silenzio, e il difetto si scopriva solo dopo aver incollato.
    const origine = new URL(page.url()).hostname;
    const locale = origine === "localhost" || origine.startsWith("127.");
    const avviso = pannello.getByTestId("profile-banner-warning");
    if (locale) {
      await expect(avviso, "da localhost il markdown NON e' condivisibile e va detto").toBeVisible({ timeout: 3000 });
      await expect(avviso).toContainText(/questo computer|indirizzo/i);
    } else {
      await expect(avviso, "da un indirizzo pubblico non serve nessun avviso").toHaveCount(0);
    }

    // E il gesto lo dice: senza conferma non si sa se ha funzionato.
    await expect(copia).toHaveText(/Copiato/, { timeout: 3000 });
  });

  test("SET-ORG: i gruppi si trovano dal menu utente e si amministrano dalla tab Profilo", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "SETORG-01" });
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });

    // NO COPY. The organisation page used to be an entry of the Settings
    // panel AND the page the Profile tab opened from «Manage»: the same page
    // in two hosts. There is no panel any more.
    await expect(page.getByTestId("settings-panel")).toHaveCount(0);

    // THE DOOR HAS ITS NAME ON IT: the Groups level of the user menu, and
    // «Manage» at its foot opens the organisation page in the Profile tab.
    await openProfileMenu(page);
    await page.getByTestId("profile-menu-orgs").click();
    const level = page.getByTestId("profile-menu-orgs-menu");
    await expect(level).toBeVisible({ timeout: 10000 });
    await level.getByTestId("org-open-manage").click();

    // And behind it they really are, called by name: a door that opens an
    // empty page would move the problem instead of closing it.
    const pagina = page.getByTestId("profile-pane").getByTestId("settings-page-organization");
    await expect(pagina).toBeVisible({ timeout: 15000 });
    await expect(
      pagina.getByTestId("identity-orgs"),
      "le organizzazioni devono avere un blocco riconoscibile dietro la loro porta",
    ).toBeVisible({ timeout: 10000 });
  });

  // SET-NOTIF-DISABLED: with the notifications master OFF, the children must be
  // REALLY disabled (out of the tab order, Space inert, state exposed to AT),
  // not just dimmed behind an `opacity/pointer-events` veil that left the button
  // switchable from the keyboard.
  test("SET-NOTIF-DISABLED: con le notifiche spente «Suono» è disattivato", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "SETORG-01" });
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    // The Notifications level of the user menu (localised: «Notifiche»).
    const level = await openUserMenuLevel(page, "notifications");

    const master = level.getByTestId("notif-enabled");
    const playSound = level.getByTestId("notif-sound");
    await expect(master).toBeVisible({ timeout: 5000 });

    // Switch the master off if it is on (the DB default may be on).
    if ((await master.getAttribute("aria-checked")) === "true") {
      await master.click();
    }
    await expect(master).toHaveAttribute("aria-checked", "false");

    // The child is disabled: `disabled` reaches all the way to the <button role=switch>.
    await expect(playSound).toBeDisabled();

    // Back on: the setting outlives this test on the shared server.
    await master.click();
    await expect(master).toHaveAttribute("aria-checked", "true");
  });
});
