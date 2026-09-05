/**
 * THE SETTINGS SPEAK ITALIAN, AND THE ORGANISATIONS CAN BE FOUND.
 *
 * Reported by whoever uses the app: «tutta la parte di settings ancora non le vedo ben divise. Non vedo le organizzazioni. In profile vedo accorpata la possibilita' anche di aggiungere piu' persone, ma non ha senso perche' io sono io e la mia mail». allow-italian: the exact words of the report are the subject
 *
 * Two distinct facts that look like one:
 *
 *  1. THE LANGUAGE. The left menu said "Appearance", "Notifications",
 *     "Profile", "Devices", "Plan" - five English words inside an app in
 *     Italian. Not a nicety: when an entry is named with a word that is not
 *     the one in your head, scanning the list fails and the conclusion is "it
 *     is not there". The repo already has a dictionary (`i18n.ts`) and the
 *     settings were the one surface not using it.
 *  2. THE ORGANISATIONS ARE THERE. `IdentitySection` owns them entirely and
 *     lives inside "Profilo". The test finds them, so the day somebody moves
 *     them back to the bottom of a tab about something else, it goes red.
 *
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

    // Le voci del menu, non una a caso: TUTTE. Una lista mezza tradotta è
    // peggio di una non tradotta, perché sembra che le due metà siano cose
    // diverse.
    const voci = pannello.locator("nav button");
    const testi = (await voci.allInnerTexts()).map((t) => t.trim()).filter(Boolean);
    expect(testi.length, "il menu deve avere delle voci").toBeGreaterThan(3);

    // Le parole inglesi che c'erano. Se tornano, questo morde.
    const inglesi = ["Appearance", "Notifications", "Profile", "Devices", "Plan"];
    for (const parola of inglesi) {
      expect(testi, `«${parola}» è inglese: il menu delle impostazioni è l'unica superficie dell'app che non passa dal dizionario`).not.toContain(parola);
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
    await page.keyboard.press("Meta+Comma");
    const pannello = page.locator('[data-testid="settings-panel"]');
    await expect(pannello).toBeVisible({ timeout: 10000 });
    await pannello.locator("nav button", { hasText: /^Profilo$/ }).click();

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

  test("SET-ORG: le organizzazioni si trovano dalle impostazioni", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "SETORG-01" });
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    await page.keyboard.press("Meta+Comma");
    const pannello = page.locator('[data-testid="settings-panel"]');
    await expect(pannello).toBeVisible({ timeout: 10000 });

    // LA PORTA HA IL NOME SCRITTO SOPRA. Il criterio di questo caso e' sempre
    // stato «le organizzazioni SI TROVANO», non «stanno in quella schermata
    // li'»: alle organizzazioni non mancava una funzione, mancava una voce con
    // scritto dove porta. Prima erano in fondo a «Profilo» e questo caso ce le
    // cercava; adesso hanno una voce loro, che e' la risposta migliore alla
    // stessa domanda. Il nome e' in italiano — «Organizzazione», non
    // «Organization» — perche' e' l'altra meta' di cio' che questo file misura.
    const org = pannello.locator("nav button", { hasText: /^Organizzazione$/ });
    await expect(org, "deve esistere una voce «Organizzazione»").toBeVisible({ timeout: 5000 });
    await org.click();

    // E dietro ci sono davvero, chiamate per nome: una voce che apre una
    // pagina vuota sposterebbe il problema invece di chiuderlo.
    await expect(
      pannello.getByTestId("identity-orgs"),
      "le organizzazioni devono avere un blocco riconoscibile dietro la loro voce",
    ).toBeVisible({ timeout: 10000 });

    // E la voce «Profilo» resta, con la sua materia: le due schermate non si
    // sono fuse, si sono separate.
    const profilo = pannello.locator("nav button", { hasText: /^Profilo$/ });
    await expect(profilo, "deve esistere anche una voce «Profilo»").toBeVisible({ timeout: 5000 });
  });

  // SET-NOTIF-DISABLED: col master delle notifiche SPENTO, i figli devono
  // essere DAVVERO disattivati — fuori dall'ordine di tab, Spazio inerte, stato
  // esposto ad AT — non solo attenuati con un velo `opacity/pointer-events` che
  // lasciava il bottone commutabile da tastiera.
  test("SET-NOTIF-DISABLED: con le notifiche spente «Play sound» è disattivato", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "SETORG-01" });
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    await page.keyboard.press("Meta+Comma");
    const pannello = page.locator('[data-testid="settings-panel"]');
    await expect(pannello).toBeVisible({ timeout: 10000 });

    // Sezione Notifiche (etichetta localizzata: /Notif/i copre «Notifiche»).
    await pannello.locator("nav button", { hasText: /Notif/i }).click();

    const master = pannello.getByRole("switch", { name: "Enable notifications" });
    const playSound = pannello.getByRole("switch", { name: "Play sound" });
    await expect(master).toBeVisible({ timeout: 5000 });

    // Spegni il master se acceso (il default del DB può essere on).
    if ((await master.getAttribute("aria-checked")) === "true") {
      await master.click();
    }
    await expect(master).toHaveAttribute("aria-checked", "false");

    // Il figlio è disabilitato: il `disabled` arriva fino al <button role=switch>.
    await expect(playSound).toBeDisabled();
  });
});
