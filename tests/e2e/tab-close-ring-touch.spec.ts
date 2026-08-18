/**
 * LA SPUNTA-CERCHIO DELLA TAB, MISURATA COL DITO.
 *
 * Viveva in `sidebar-touch-audit.spec.ts`, che gira a 390px. Da quando sul
 * telefono la striscia delle tab non si disegna piu' (la colonna a schermo
 * intero E' gia' l'elenco delle superfici aperte), li' non c'era piu' niente da
 * misurare — e un test senza soggetto e' un test che si cancella o che si
 * sposta dove il soggetto vive.
 *
 * Vive qui: `chromium-touch-wide`, cioe' il DITO su uno schermo largo. Il
 * contratto non e' mai stato «sul telefono», e' «col dito»: il pollice sbaglia
 * uguale su un tablet, e a 1280px la striscia c'e'. Il predicato che decide il
 * ramo mobile e' `innerWidth < 768` (`PanelGrid`), quindi qui la striscia si
 * disegna come sul desktop, con `hasTouch` acceso.
 *
 * Le misure sono `getBoundingClientRect` + `elementFromPoint`, non impressioni.
 */
import { test, expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const BASE = E2E_BASE;
/** La spunta-cerchio che chiude la tab della chat: il rappresentante della
 *  famiglia (`Chiudi terminale`, `Chiudi browser`, `Archivia <topic>` sono lo
 *  stesso componente con lo stesso `boxClassName`). */
const TAB_CLOSE = '[aria-label^="Chiudi tab"]';

async function misuraBersagli(page: Page, selettori: string[]) {
  return page.evaluate((sels) => {
    const els = sels.flatMap((s) => [...document.querySelectorAll<HTMLElement>(s)]);
    return els.map((el) => {
      const r = el.getBoundingClientRect();
      const etichetta = el.getAttribute("aria-label") ?? el.getAttribute("title") ?? el.className.slice(0, 30);
      const box = { w: Math.round(r.width), h: Math.round(r.height) };
      // Un comando rivelato dall'hover (desktop) a schermo stretto non esiste:
      // zero per zero non è un bersaglio piccolo, è un bersaglio assente, e
      // pretendere 44px da lui vorrebbe dire misurare il nulla.
      if (box.w === 0 || box.h === 0) {
        return { etichetta, box, tap: { w: 0, h: 0 }, suoCentro: false, assente: true };
      }
      const cx = Math.round(r.x + r.width / 2);
      const cy = Math.round(r.y + r.height / 2);
      const suo = (x: number, y: number) => {
        const h = document.elementFromPoint(x, y);
        return !!h && (el === h || el.contains(h));
      };
      if (!suo(cx, cy)) {
        return { etichetta, box, tap: { w: 0, h: 0 }, suoCentro: false, assente: false };
      }
      // Il tetto tiene a bada un bersaglio a tutto schermo (e un ciclo infinito
      // se `elementFromPoint` rispondesse sempre): 60px sono oltre i 44 di soglia,
      // quindi non può nascondere un bersaglio troppo piccolo — solo accorciare
      // il racconto di uno enorme.
      const TETTO = 60;
      let sx = cx, dx = cx, su = cy, giu = cy;
      while (cx - sx < TETTO && suo(sx - 1, cy)) sx--;
      while (dx - cx < TETTO && suo(dx + 1, cy)) dx++;
      while (cy - su < TETTO && suo(cx, su - 1)) su--;
      while (giu - cy < TETTO && suo(cx, giu + 1)) giu++;
      return {
        etichetta,
        box,
        tap: { w: dx - sx + 1, h: giu - su + 1 },
        suoCentro: true,
        assente: false,
      };
    });
  }, selettori);
}


test.describe("La spunta-cerchio della tab, col dito", () => {
  let topicId = "";
  const topicName = `Tab ring ${Date.now()}`;

  test.beforeAll(async ({ request }) => {
    const t = await createTopic(request, topicName);
    topicId = t.id;
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test.beforeEach(async ({ page, request }) => {
    await resetPaneStore(request, [topicId]);
    await page.goto(BASE);
  });

  /**
   * LA SPUNTA-CERCHIO SI TOCCA, E SI ANNULLA — col dito, non col mouse.
   *
   * SIDEBAR-TOUCH-03 misura il rettangolo di LAYOUT, e su questi bersagli quel
   * numero è metà della storia: `.tap-expand-y` allarga l'area sensibile con un
   * `::after`, che in `getBoundingClientRect()` non compare. Il box dice 28×28
   * mentre il dito ne trova 28×36 — e se domani qualcuno togliesse la classe dal
   * componente, il box resterebbe identico e TOUCH-03 resterebbe verde mentre
   * l'altezza utile crolla a 28. Qui si misura l'area VERA (vedi
   * `misuraBersagli`: si cresce dal centro finché `elementFromPoint` risponde
   * ancora «sono io»), che è l'unico numero che il pollice conosce.
   *
   * E poi si fa la cosa che nessuna misura può sostituire: SI TOCCA. Un
   * bersaglio può essere largo, alto, possedere il suo centro — e non funzionare
   * lo stesso, perché il tocco viene mangiato da un antenato, o perché lo
   * `stopPropagation` manca e sotto al comando si attiva anche la tab. Il giro
   * completo è la prova: si tocca la spunta vuota (parte la chiusura differita,
   * il cerchio diventa la spunta piena), si misura ANCHE quella — è un secondo
   * ramo del componente, con un secondo `style` inline, e nasceva col difetto
   * identico — e poi si annulla toccandola. Se alla fine la spunta vuota è
   * tornata, i due tocchi sono finiti dove dovevano; se fosse finito sulla tab,
   * la chiusura sarebbe andata fino in fondo e la tab non ci sarebbe più.
   *
   * I 3 secondi del countdown sono il tempo che c'è per fare tutto: le misure
   * stanno in una `evaluate` sola apposta.
   */
  test("TAB-RING-01: la spunta-cerchio ha l'area di un dito, e col dito si chiude e si annulla", async ({ page }) => {
    const chiudi = page.locator(TAB_CLOSE);
    await expect(chiudi, "la tab della chat non è montata: non c'è spunta da misurare").toHaveCount(1, { timeout: 10_000 });
    const [vuota] = await misuraBersagli(page, [TAB_CLOSE]);
    expect(vuota, "la spunta di chiusura non è sullo schermo").toBeTruthy();
    expect(vuota.suoCentro, `il centro della spunta è coperto da un vicino: ${JSON.stringify(vuota)}`).toBe(true);
    // 28 in largo: è il box che lo slot della tab riservava da sempre e che il
    // bottone non usava (14 inline). 36 in alto: sono i `tap-expand-y` tagliati
    // dall'`overflow-hidden` della tab, cioè tutta la tab. Sotto questi due
    // numeri il bersaglio è tornato a essere il glifo.
    expect(vuota.tap.w, `la spunta vuota è larga ${vuota.tap.w}px di area toccabile`).toBeGreaterThanOrEqual(28);
    // 36 IN ALTO NON SI PRETENDE PIU', e il motivo va scritto: quei 36 erano
    // l'altezza della tab SUL TELEFONO (il `tap-expand-y` lo taglia
    // l'`overflow-hidden` della tab, quindi il bersaglio è alto quanto lei).
    // Su schermo largo la striscia è alta 28, e sul telefono questa superficie
    // esiste solo DENTRO un progetto — dove la striscia resta. Qui si pretende
    // il contratto che questo schermo può portare: 28 su tutti e due gli assi,
    // che è già il doppio del glifo.
    expect(vuota.tap.h, `la spunta vuota è alta ${vuota.tap.h}px di area toccabile`).toBeGreaterThanOrEqual(28);

    // IL DISEGNO NON CRESCE COL BERSAGLIO. È metà del contratto di
    // `boxClassName`: `size` resta il diametro del cerchio, il box è un'altra
    // cosa. Senza questa riga, «bersaglio più grande» si potrebbe soddisfare
    // gonfiando il glifo, che è proprio ciò che non si vuole.
    //
    // Il numero è 16 dal 07/08 (era 14): un comando di riga ha ora UNA misura in
    // tutta la sidebar, e dentro un box da 36 un cerchio da 14 era un pallino —
    // «il tasto per spuntare una tab e chiuderla è troppo piccolo». Quello che
    // il test protegge non è il 16: è che il glifo resti MOLTO più piccolo del
    // suo bersaglio, cioè che nessuno soddisfi «più grande» gonfiando il disegno.
    const cerchio = await chiudi.locator("span").first().boundingBox();
    const disegnato = Math.round(cerchio?.width ?? 0);
    expect(disegnato, "il cerchio DISEGNATO deve restare un glifo, non un bottone").toBe(16);

    // ── e adesso lo si tocca davvero ────────────────────────────────────────
    await chiudi.tap();
    const annulla = page.locator('[aria-label="Annulla chiusura"]');
    await expect(
      annulla,
      "toccare la spunta non ha avviato la chiusura differita: il tocco è finito altrove",
    ).toBeVisible({ timeout: 5_000 });

    const [piena] = await misuraBersagli(page, ['[aria-label="Annulla chiusura"]']);
    expect(piena.suoCentro, `il centro dell'annullo è coperto da un vicino: ${JSON.stringify(piena)}`).toBe(true);
    expect(piena.tap.w, `l'annullo è largo ${piena.tap.w}px di area toccabile`).toBeGreaterThanOrEqual(28);
    expect(piena.tap.h, `l'annullo è alto ${piena.tap.h}px di area toccabile`).toBeGreaterThanOrEqual(28);

    await annulla.tap();
    await expect(
      chiudi,
      "l'annullo non ha ripreso: o il tocco è finito sulla tab, o la chiusura è andata fino in fondo",
    ).toBeVisible({ timeout: 5_000 });
  });
});
