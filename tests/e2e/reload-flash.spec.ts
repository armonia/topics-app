import { expect, test } from "@playwright/test";
import { goToApp } from "./helpers";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/**
 * RELOAD-FLASH — dopo un ⌘R la app deve DIRE di aver ricaricato.
 *
 * Il difetto non era il reload: era il silenzio. Un ricarico che rifà lo stesso
 * schermo è indistinguibile dal non aver fatto niente, e la segnalazione «cmd r
 * non sembra andare» è arrivata su un guscio in cui ⌘R funzionava — la mano
 * aveva premuto, la app aveva obbedito, e nessuno dei due lo sapeva.
 *
 * Cosa può misurare questo test e cosa no. Il gesto ⌘R nel desktop lo intercetta
 * un monitor NSEvent nativo (`lib.rs`), che qui non esiste: Playwright guida un
 * Chromium, non il guscio Tauri. Quello che il monitor fa però è esattamente una
 * cosa, e in una riga sola: mettere il segno in `sessionStorage` e ricaricare
 * (`RELOAD_WITH_FLASH_JS`). Quel contratto — la chiave, e il fatto che i tre
 * percorsi nativi ci passino tutti — è verificato in `client/src/lib/
 * reloadFlash.test.ts` leggendo il sorgente Rust. Qui si verifica l'altra metà,
 * quella che il monitor non può fare da solo: che il segno, dall'altra parte del
 * reload, DIVENTI una frase sullo schermo.
 *
 * Da cui la forma del test: si scrive il marcatore come lo scriverebbe il
 * nativo, si ricarica per davvero, si guarda se la app parla.
 */
test.describe("flash «Ricaricata»", () => {
  test("un reload marcato dal guscio si annuncia", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "RELOAD-01" });
    await goToApp(page);

    // Nessun toast a freddo: il flash è un ACK, non un saluto di benvenuto.
    await expect(page.getByText("Ricaricata")).toHaveCount(0);

    // Il segno che lascia il nativo prima di ricaricare — stessa chiave, stesso
    // valore di RELOAD_WITH_FLASH_JS in desktop-tauri/src-tauri/src/lib.rs.
    await page.evaluate(() => sessionStorage.setItem("topics:reloaded", "1"));
    await page.reload();

    await expect(page.getByText("Ricaricata")).toBeVisible();
  });

  test("un reload NON chiesto resta muto", async ({ page }) => {
    await goToApp(page);
    // Un crash del WebContent, o un ricarico del guscio, non lascia nessun
    // segno: il toast afferma «hai premuto e ha risposto», non «la pagina è
    // ripartita». Se parlasse anche qui, direbbe una cosa falsa.
    await page.reload();
    await expect(page.getByText("Ricaricata")).toHaveCount(0);
  });

  test("il segno vale una volta sola", async ({ page }) => {
    await goToApp(page);
    await page.evaluate(() => sessionStorage.setItem("topics:reloaded", "1"));
    await page.reload();
    await expect(page.getByText("Ricaricata")).toBeVisible();
    // Consumato: il reload successivo non ripesca lo stesso annuncio.
    await page.reload();
    await expect(page.getByText("Ricaricata")).toHaveCount(0);
  });
});
