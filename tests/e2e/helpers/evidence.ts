/**
 * evidence.ts — i due attrezzi che servono SOLO a una clip di consegna.
 *
 * Sotto `E2E_EVIDENCE=1` la suite registra il video di ogni test: quella clip è
 * la prova che l'AC passa, e finisce come anteprima di un task, resa a 268px di
 * larghezza. Da un video di una UI a 1440px, a quella scala, non si legge una
 * riga — «devi ancora saper dire cosa mostra» non lo soddisfa una macchia di
 * pannelli. Quindi: una didascalia grande che sopravvive alla riduzione, e una
 * pausa che dà il tempo di leggerla.
 *
 * Entrambi sono NO-OP fuori da una passata che registra: nella passata normale
 * la suite non paga né i millisecondi né il DOM in più.
 *
 * DUE MODI DI REGISTRARE, e questi attrezzi valgono per tutti e due.
 *  · `E2E_EVIDENCE=1` — il modo storico: `slowMo` + video su OGNI test, dal
 *    `use` di `playwright.config.ts`. La clip contiene anche il setup.
 *  · `E2E_CLIP=1` — un contesto DEDICATO acceso sul solo tratto utile, con la
 *    durata misurata sul file (`helpers/clip.ts`). Niente slowMo, niente video
 *    sugli altri test.
 * Le pause e le didascalie servono in entrambi: una clip senza fermi immagine
 * non si legge a 268px, che è la larghezza a cui una card la mostra.
 */
import type { Page } from "@playwright/test";

export const isEvidenceRun = () =>
  process.env.E2E_EVIDENCE === "1" || process.env.E2E_CLIP === "1";

/** Pausa leggibile nella clip; zero nella passata veloce. */
export const beat = (page: Page, ms = 1200) =>
  isEvidenceRun() ? page.waitForTimeout(ms) : Promise.resolve();

/**
 * Didascalia in basso sulla clip. `pointer-events:none` e in fondo: non copre
 * i drawer e non intercetta un click, quindi non può cambiare l'esito del test.
 */
export async function didascalia(page: Page, testo: string): Promise<void> {
  if (!isEvidenceRun()) return;
  await page.evaluate((t) => {
    let el = document.getElementById("__e2e_caption__");
    if (!el) {
      el = document.createElement("div");
      el.id = "__e2e_caption__";
      el.setAttribute(
        "style",
        "position:fixed;left:0;right:0;bottom:0;z-index:2147483647;pointer-events:none;" +
        "background:rgba(10,10,12,.92);color:#fff;font:700 44px/1.25 system-ui,sans-serif;" +
        "padding:14px 20px;letter-spacing:-.01em;border-top:3px solid #8b5cf6;",
      );
      document.body.appendChild(el);
    }
    el.textContent = t;
  }, testo);
}
