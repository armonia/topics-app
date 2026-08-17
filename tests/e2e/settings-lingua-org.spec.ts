/**
 * LE IMPOSTAZIONI PARLANO ITALIANO, E LE ORGANIZZAZIONI SI TROVANO.
 *
 * Segnalato: «tutta la parte di settings ancora non le vedo ben divise. Non
 * vedo le organizzazioni. In profile vedo accorpata la possibilità anche di
 * aggiungere più persone, ma non ha senso perché io sono io e la mia mail».
 *
 * Due fatti distinti, che sembrano lo stesso:
 *
 *  1. LA LINGUA. Il menu di sinistra diceva «Appearance», «Notifications»,
 *     «Profile», «Devices», «Plan» — cinque parole inglesi in un'app in
 *     italiano. Non è un vezzo: quando una voce si chiama con una parola che
 *     non è quella che hai in testa, la scansione della lista fallisce e la
 *     conclusione è «non c'è». Il repo ha già un dizionario (`i18n.ts`) e i
 *     settings erano l'unica superficie che non lo usava.
 *  2. LE ORGANIZZAZIONI CI SONO. `IdentitySection` le gestisce per intero e sta
 *     dentro «Profilo». Il test le trova, così se un domani qualcuno le sposta
 *     di nuovo in fondo a una scheda che parla d'altro, diventa rosso.
 */
import { test, expect } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

test.describe("Impostazioni · lingua e organizzazioni", () => {
  test.describe.configure({ timeout: 60_000 });

  test("SET-LINGUA: il menu delle impostazioni è in italiano", async ({ page }) => {
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

  test("SET-ORG: le organizzazioni si trovano dalle impostazioni", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    await page.keyboard.press("Meta+Comma");
    const pannello = page.locator('[data-testid="settings-panel"]');
    await expect(pannello).toBeVisible({ timeout: 10000 });

    // La voce che contiene l'identità: si chiama «Profilo», non «Profile».
    const profilo = pannello.locator("nav button", { hasText: /^Profilo$/ });
    await expect(profilo, "deve esistere una voce «Profilo»").toBeVisible({ timeout: 5000 });
    await profilo.click();

    // E dentro ci sono le organizzazioni, chiamate per nome. Senza un titolo
    // che le nomini, «non vedo le organizzazioni» resta vero anche quando il
    // codice che le gestisce c'è: era esattamente il caso.
    await expect(
      pannello.getByTestId("identity-orgs"),
      "le organizzazioni devono avere un blocco riconoscibile dentro Profilo",
    ).toBeVisible({ timeout: 10000 });
  });
});
