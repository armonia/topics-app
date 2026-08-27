import { test, expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";
import { clipDiConsegna } from "./helpers/clip";
import { E2E_BASE } from "./helpers/test-server";
import { beat } from "./helpers/evidence";

/**
 * I FOGLI DAL BASSO, MISURATI COL DITO.
 *
 * Segnalati dal telefono, due difetti nella stessa frase:
 *
 *  1. «se ho un overlay e clicco fuori per chiuderlo, mi conta l'azione sugli
 *     elementi sottostanti, ma se ho il coso avanti dovrei prima chiudere il
 *     coso perché magari non si vede manco dove sto cliccando»;
 *  2. «per le cose che escono da sotto dovrei poter fare drag naturale che
 *     segue per richiuderlo».
 *
 * Cosa si misura qui, e perché uno screenshot non basterebbe:
 *
 *  · DURANTE il gesto il foglio sta dove sta il dito. Non «alla fine è chiuso»:
 *    quello sarebbe vero anche con una soglia letta a dito già staccato, che è
 *    un pulsante azionato di traverso. Si campiona il bordo SUPERIORE del foglio
 *    a ogni passo del tocco e lo si confronta col dito, ±8px.
 *  · Al rilascio decide il gesto: corsa breve e LENTA rimette il foglio a posto.
 *    Due esiti opposti dallo stesso meccanismo.
 *  · Il tocco che chiude un menu NON aziona ciò che sta sotto — e il tocco DOPO
 *    sì, altrimenti avremmo solo rotto il bersaglio.
 *
 * I tocchi si costruiscono nella pagina: Playwright non ha una primitiva di
 * trascinamento col dito, e `useSheetDrag` legge `e.touches[0].clientY`, che
 * vuole veri oggetti `Touch`. Si sparano su `document`, dove il gesto ascolta
 * (React registra i suoi listener come passivi: `preventDefault` da un
 * `onTouchMove` sarebbe un no-op, quindi il gesto NON può stare su React).
 */

hermetic(test);

const SIDEBAR = '[aria-label="Topics sidebar"]';
/** Il bottone «Topics ▾» in testa alla colonna: sotto i 768px il suo menu è un foglio. */
const TRIGGER = '[data-testid="sidebar-topics-menu"]';
const FOGLIO = '[data-testid="sidebar-topics-menu-panel"]';

const creati: string[] = [];

/**
 * Lo stato del cassetto è per-dispositivo e sopravvive al reload: senza
 * dichiararlo, il test erediterebbe l'ultimo gesto di chi è passato di qui.
 */
async function apriApp(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("topics-mobile-drawer-collapsed", "0");
  });
  await page.goto("/");
  await page.waitForSelector(SIDEBAR, { state: "visible", timeout: 15_000 });
}

/** Apre il foglio e aspetta che sia FERMO: l'animazione d'ingresso dura 300ms,
 *  e un campione preso dentro quella finestra parla di lei, non del gesto. */
async function openSheet(page: Page): Promise<number> {
  await page.tap(TRIGGER);
  const foglio = page.locator(FOGLIO);
  await expect(foglio).toBeVisible({ timeout: 5_000 });
  let fermo = -1;
  await expect
    .poll(async () => {
      const t = Math.round((await foglio.boundingBox())!.y);
      const stabile = t === fermo;
      fermo = t;
      return stabile;
    }, { message: "il foglio deve posarsi prima che il dito lo tocchi", timeout: 5_000 })
    .toBe(true);
  return fermo;
}

interface Campione { dito: number; bordo: number }

/**
 * Un trascinamento verso il basso, campionato passo per passo.
 *
 * Fra un `touchmove` e la misura si aspettano DUE frame: il gesto scrive la
 * `transform` dentro un `requestAnimationFrame` (un solo write per frame, che è
 * il motivo per cui non sfarfalla), quindi misurare subito leggerebbe il
 * fotogramma precedente e accuserebbe il codice di un ritardo che non ha.
 */
async function dragDown(
  page: Page,
  opts: { x: number; y0: number; y1: number; passi: number; pausaMs: number; selettore: string },
): Promise<Campione[]> {
  return page.evaluate(async ({ x, y0, y1, passi, pausaMs, selettore }) => {
    const foglio = document.querySelector(selettore) as HTMLElement;
    const nodo = (document.elementFromPoint(x, y0) ?? foglio) as Element;

    // IL DITO, DISEGNATO. Un tocco sintetico non lascia traccia sullo schermo, e
    // una clip in cui si vede solo il pannello scivolare non distingue «segue il
    // dito» da «un'animazione partita da sola» — cioè non prova la cosa che
    // questa spec afferma. Il cerchio è decorazione DEL TEST: `pointer-events:
    // none`, appeso al body e tolto alla fine, l'app non lo vede mai.
    const dito = document.createElement("div");
    dito.style.cssText = `position:fixed;z-index:2147483647;pointer-events:none;width:44px;height:44px;
      margin:-22px 0 0 -22px;border-radius:9999px;background:rgba(255,255,255,.35);
      border:2px solid rgba(255,255,255,.9);box-shadow:0 0 12px rgba(0,0,0,.5)`;
    document.body.appendChild(dito);
    const muoviIlDito = (px: number, py: number) => { dito.style.left = `${px}px`; dito.style.top = `${py}px`; };
    muoviIlDito(x, y0);

    const tocco = (py: number) => new Touch({ identifier: 9, target: nodo, clientX: x, clientY: py });
    // Gli eventi partono DAL NODO SOTTO IL DITO e salgono, come quelli veri.
    // Sparati su `document` avrebbero `target === document`, cioè «fuori dal
    // foglio» per `useDismissable`, che lo chiuderebbe al primo tocco: il test
    // misurerebbe un foglio smontato (rect tutto a zero) e accuserebbe il
    // trascinamento di un difetto che è del suo dito finto.
    const spara = (tipo: string, t: Touch, attivi: Touch[]) =>
      nodo.dispatchEvent(new TouchEvent(tipo, {
        bubbles: true, cancelable: true, touches: attivi, targetTouches: attivi, changedTouches: [t],
      }));
    const dueFrame = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    const attesa = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    const primo = tocco(y0);
    spara("touchstart", primo, [primo]);

    const campioni: { dito: number; bordo: number }[] = [];
    for (let i = 1; i <= passi; i++) {
      const y = y0 + ((y1 - y0) * i) / passi;
      const t = tocco(y);
      spara("touchmove", t, [t]);
      muoviIlDito(x, y);
      await attesa(pausaMs);
      await dueFrame();
      campioni.push({ dito: y, bordo: foglio.getBoundingClientRect().top });
    }
    const ultimo = tocco(y1);
    spara("touchend", ultimo, []);
    // Il cerchio resta un istante dopo il rilascio: nella clip è il momento in
    // cui si vede che il foglio prosegue da solo, con la sua inerzia.
    setTimeout(() => dito.remove(), 500);
    return campioni;
  }, opts);
}

test.describe("Il foglio dal basso sta sotto il dito", () => {
  test.afterAll(async ({ request }) => {
    for (const id of creati) await deleteTopic(request, id).catch(() => {});
    creati.length = 0;
  });

  /**
   * SHEET-01 è anche LA CLIP DI CONSEGNA: gira dentro `clipDiConsegna`
   * (helpers/clip.ts), che sotto `E2E_CLIP=1` registra il solo tratto utile in
   * un contesto dedicato e misura il .webm. Senza quella variabile fa
   * esattamente gli stessi passi senza video: il percorso di codice è UNO, così
   * la clip non prova una strada diversa da quella che gira nel gate.
   */
  test("SHEET-01: il bordo del foglio è dove è il dito, e se ne va con lui", async () => {
    test.info().annotations.push({ type: "spec", description: "SHEET-01" });
    await clipDiConsegna({
      nome: "sheet-finger-follow-01",
      context: {
        baseURL: E2E_BASE,
        locale: "it-IT",
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
        deviceScaleFactor: 2,
      },
      // Il setup — l'app che parte, la colonna che si monta — sta qui, su una
      // pagina il cui video si butta.
      prologo: async (page) => { await apriApp(page); },
      scena: async (page) => {
        await apriApp(page);
        await beat(page, 600);
        const cima = await openSheet(page);
        await beat(page, 900);

        // Si parte da 12px sotto il bordo del foglio: la maniglia, cioè il
        // punto che un pollice cerca.
        const campioni = await dragDown(page, {
          x: 195, y0: cima + 12, y1: cima + 300, passi: 7, pausaMs: 20, selettore: FOGLIO,
        });

        // Il primo campione può essere ancora sotto la soglia d'asse (8px): lì
        // il gesto non ha deciso se è uno scorrimento, e non DEVE aver mosso
        // niente. Da quando si è preso in poi, il foglio è attaccato al dito.
        const partenza = cima + 12;
        for (const c of campioni.filter((x) => x.dito - partenza > 8)) {
          const atteso = cima + (c.dito - partenza);
          expect(
            Math.abs(c.bordo - atteso),
            `col dito a ${Math.round(c.dito)} il bordo del foglio era a ${Math.round(c.bordo)} invece che a ${Math.round(atteso)}`,
          ).toBeLessThanOrEqual(8);
        }
        // Non vacuo: se il foglio non si fosse mai mosso, il ciclo sopra sarebbe
        // stato verde solo per un elenco vuoto.
        expect(campioni.filter((c) => c.bordo > cima + 50).length).toBeGreaterThanOrEqual(4);

        await expect(page.locator(FOGLIO)).toHaveCount(0, { timeout: 5_000 });
        await beat(page, 900);
      },
    });
  });

  test("SHEET-02: al rilascio decide il gesto, e una corsa breve e LENTA non chiude niente", async ({ page }) => {
    await apriApp(page);
    const cima = await openSheet(page);

    // ~60px di corsa a 120ms per passo fanno ~0,17px/ms: sotto la soglia del
    // lancio, e ben sotto la metà del foglio. Il dito ha spinto e ci ha
    // ripensato — il foglio torna dov'era.
    const campioni = await dragDown(page, {
      x: 195, y0: cima + 12, y1: cima + 72, passi: 3, pausaMs: 120, selettore: FOGLIO,
    });
    // Durante la corsa si era mosso davvero: si prova la POSA, non che il gesto
    // sia stato ignorato.
    expect(campioni.at(-1)!.bordo).toBeGreaterThan(cima + 30);

    await expect(page.locator(FOGLIO)).toBeVisible();
    await expect
      .poll(async () => Math.round((await page.locator(FOGLIO).boundingBox())!.y), {
        message: "il foglio deve tornare al suo posto",
        timeout: 5_000,
        intervals: [50, 100, 200],
      })
      .toBe(cima);
  });
});

/**
 * IL TOCCO CHE CHIUDE NON FA ANCHE L'ALTRA COSA.
 *
 * Il menu di riga (tieni premuto) è un `ContextMenuPortal`: non ha velo, quindi
 * il dito che lo chiude atterra DAVVERO sulla pagina sotto. Prima di
 * `lib/outsidePress` quel dito faceva due cose in un colpo: chiudeva il menu e
 * apriva il foglio del bottone che aveva sfiorato.
 *
 * Le due metà vanno insieme: la prima da sola sarebbe verde anche su un
 * bersaglio rotto per sempre, la seconda da sola non direbbe niente.
 */
test.describe("Chiudere un overlay è tutto ciò che quel tocco fa", () => {
  let topicName = "";

  test.beforeAll(async ({ request }) => {
    topicName = `Foglio ${Date.now()}`;
    const t = await createTopic(request, topicName);
    creati.push(t.id);
  });

  test.afterAll(async ({ request }) => {
    for (const id of creati) await deleteTopic(request, id).catch(() => {});
    creati.length = 0;
  });

  test("SHEET-03: col menu aperto il primo tocco chiude, il secondo aziona", async ({ page }) => {
    await apriApp(page);
    const riga = page.getByRole("treeitem", { name: topicName });
    await expect(riga).toBeVisible({ timeout: 10_000 });

    // Tieni premuto: il menu vero, quello del tasto destro (useLongPress).
    await riga.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const touch = new Touch({ identifier: 3, target: el, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 });
      const fire = (type: string, touches: Touch[]) =>
        el.dispatchEvent(new TouchEvent(type, {
          bubbles: true, cancelable: true, touches, targetTouches: touches, changedTouches: [touch],
        }));
      fire("touchstart", [touch]);
      return new Promise<void>((resolve) => setTimeout(() => { fire("touchend", []); resolve(); }, 750));
    });
    await expect(page.getByText("Rinomina", { exact: true })).toBeVisible({ timeout: 5_000 });

    // Il tocco FUORI, su un bersaglio vero: il bottone «Topics ▾».
    await page.tap(TRIGGER);
    await expect(page.getByText("Rinomina", { exact: true })).toHaveCount(0, { timeout: 5_000 });
    // …e il bottone NON si è azionato: nessun foglio.
    await expect(page.locator(FOGLIO)).toHaveCount(0);

    // Il tocco dopo è di nuovo dell'utente: il bersaglio funziona.
    await page.tap(TRIGGER);
    await expect(page.locator(FOGLIO)).toBeVisible({ timeout: 5_000 });
  });
});
