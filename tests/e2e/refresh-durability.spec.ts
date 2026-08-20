import { expect, test } from "@playwright/test";
import { resolve } from "path";
import { goToApp, openTestChat } from "./helpers";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/**
 * LA MATRICE DELLA DURABILITA': cosa sopravvive a un ricaricamento.
 *
 * PERCHE' ESISTE. Questo repo misura il peso del bundle, la latenza di quattro
 * rotte, i frame chiesti a riposo, i millisecondi fra il clic e l'inchiostro.
 * Non aveva un solo numero sulla domanda che un utente si fa piu' spesso di
 * tutte: «se ricarico, perdo qualcosa?». La risposta viveva nella memoria di
 * chi aveva scritto quel pezzo, e ventotto spec toccano un `page.reload()`
 * ognuna per la sua ragione, nessuna per dichiarare un contratto.
 *
 * LA FORMA. Una riga per (superficie, stato): si mette lo stato, si ricarica,
 * si asserisce. Le righe che dicono RESTA sono un contratto. Le righe che
 * dicono PERDE sono un contratto uguale e contrario, e servono almeno quanto
 * le altre: la posizione di scroll della chat NON e' persistita da una
 * decisione presa il 06/08/2026 con una misura in mano
 * (`state/pane/middleware/persistLocal.ts:21-29`), e senza una riga che lo
 * dica qualcuno la ripristinerebbe credendo di correggere un difetto.
 *
 * COSA NON E'. Non e' una spec di performance e non misura tempi: qui conta
 * solo cosa c'e' e cosa non c'e' dopo il ritorno. Il costo del ritorno lo
 * misura `refresh-cls.spec.ts`.
 */

const PIXEL = resolve(__dirname, "fixtures/pixel.png");

test.describe.serial("Durabilita' al ricaricamento", () => {
  test("il testo non spedito del composer RESTA", async ({ page }) => {
    await goToApp(page);
    const composer = await openTestChat(page);

    const frase = "questa frase deve sopravvivere al ricaricamento";
    await composer.fill(frase);
    // La persistenza passa da un effetto su `message`: si aspetta che la
    // chiave esista davvero, non un tempo.
    await expect
      .poll(() => page.evaluate(() =>
        Object.keys(localStorage).some((k) => k.startsWith("draft:") && (localStorage.getItem(k) ?? "").includes("sopravvivere"))),
      )
      .toBe(true);

    await page.reload({ waitUntil: "domcontentloaded" });
    const dopo = await openTestChat(page);
    await expect(dopo).toHaveValue(frase);
  });

  test("un allegato del composer RESTA, come il testo che lo accompagna", async ({ page }) => {
    await goToApp(page);
    const composer = await openTestChat(page);

    // Il caso vero e' questo: una frase CHE PARLA dell'allegato. Se sopravvive
    // solo la frase, la perdita non assomiglia a una perdita — si preme Invio e
    // si spedisce «guarda questo screenshot» senza screenshot.
    await composer.fill("guarda questo screenshot");
    await page.locator('input[type=file]').first().setInputFiles(PIXEL);
    await expect(page.getByTestId("composer-attachment")).toHaveCount(1);

    // Il chip che compare dice che lo STATO React ha l'allegato, non che il
    // deposito ce l'ha: la scrittura su IndexedDB parte da un effetto ed e'
    // asincrona. Ricaricare qui e' una corsa, e sotto contesa la si perde
    // (visto: un flaky su una passata a due shard, 20/08). La precondizione
    // vera e' «la riga esiste nel deposito», e si puo' chiedere.
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            // `indexedDB.open(nome)` CREA il database se non c'e', a versione 1
            // e senza object store. Se la sonda arrivasse per prima, la `open`
            // dell'app troverebbe la versione 1 gia' buona, non farebbe scattare
            // `onupgradeneeded`, e lo store non nascerebbe mai: la sonda
            // romperebbe cio' che misura. Quindi prima si CHIEDE se esiste.
            const esistenti = await indexedDB.databases();
            if (!esistenti.some((d) => d.name === "topics-drafts")) return 0;
            return new Promise<number>((risolvi) => {
              const req = indexedDB.open("topics-drafts");
              req.onerror = () => risolvi(-1);
              req.onsuccess = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains("attachments")) return risolvi(0);
                const q = db.transaction("attachments", "readonly").objectStore("attachments").count();
                q.onsuccess = () => risolvi(q.result);
                q.onerror = () => risolvi(-1);
              };
            });
          }),
        { timeout: 15_000, message: "l'allegato non e' mai arrivato nel deposito" },
      )
      .toBeGreaterThan(0);

    await page.reload({ waitUntil: "domcontentloaded" });
    const dopo = await openTestChat(page);

    await expect(dopo).toHaveValue("guarda questo screenshot");
    await expect(
      page.getByTestId("composer-attachment"),
      "il testo e' tornato e l'allegato no: e' esattamente la perdita che non si vede",
    ).toHaveCount(1);
  });

  test("la posizione di scroll della chat NON resta, ed e' voluto", async ({ page }) => {
    // Il contrario di un difetto: la chiave `pane-store-scroll-offsets` e'
    // stata TOLTA il 06/08/2026. Questa riga difende quella decisione.
    await goToApp(page);
    await openTestChat(page);
    const chiavi = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.includes("scroll-offset")));
    expect(chiavi, "e' tornata una chiave di scroll: leggere persistLocal.ts:21-29 prima di aggiungerla").toEqual([]);
  });
});
