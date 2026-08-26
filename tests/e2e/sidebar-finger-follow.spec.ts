/**
 * @covers FINGER-01
 */
import { test, expect, type Page } from "@playwright/test";
import { E2E_BASE } from "./helpers/test-server";
import { createTopic, deleteTopic } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

/**
 * IL DITO COMANDA — misurato.
 *
 * Attilio, 12/08, dal telefono: «la sidebar non segue bene lo scroll del dito
 * quando faccio lo swipe per aprirla o per chiuderla» e «mentre scrollo si
 * sminchiano i pinnati, fanno scatti strani». Sono due difetti diversi con lo
 * stesso sintomo: qualcosa si muove per conto suo invece che con te.
 *
 * Cosa si misura qui, e perché non basta uno screenshot:
 *
 *  1. DURANTE il gesto la colonna sta dove sta il dito. Non «alla fine il
 *     cassetto è aperto» — quello era vero anche prima, con una soglia letta a
 *     dito già staccato: si campiona il bordo destro del cassetto a ogni passo
 *     del tocco e lo si confronta col dito, ±8px.
 *
 *  2. Al rilascio decide il gesto, non una costante. Corsa lunga e veloce →
 *     apre; corsa breve e LENTA → torna indietro. Due esiti opposti dallo
 *     stesso meccanismo: una soglia fissa a ±60px non li darebbe entrambi.
 *
 *  3. Le tessere fissate non si muovono quando la colonna scorre. Il test crea
 *     apposta la condizione che le faceva scattare — scorrimento vero PIÙ un
 *     render vero a metà scorrimento — e pretende che la posizione DENTRO la
 *     griglia non cambi di un pixel.
 *
 * I tocchi si costruiscono nella pagina: Playwright non ha una primitiva di
 * trascinamento col dito, e `useSidebarSwipe` legge `e.touches[0].clientX`, che
 * vuole veri oggetti `Touch`. Si sparano su `document` perché è lì che il gesto
 * ascolta (React registra i suoi listener come passivi: `preventDefault` da un
 * `onTouchMove` sarebbe un no-op, quindi il gesto NON può stare su React).
 */

hermetic(test);

const SIDEBAR = '[aria-label="Topics sidebar"]';
const creati: string[] = [];

/** Il cassetto parte da uno stato DICHIARATO: la chiave è per-dispositivo e
 *  sopravvive al reload, quindi senza questo il test erediterebbe l'ultimo
 *  gesto di chi è passato di qui. */
async function apriApp(page: Page, chiuso: boolean): Promise<void> {
  await page.addInitScript((c) => {
    localStorage.setItem("topics-mobile-drawer-collapsed", c ? "1" : "0");
  }, chiuso);
  await page.goto("/");
  await page.waitForSelector(SIDEBAR, { state: "attached", timeout: 15_000 });
  // La colonna deve essere FERMA prima di misurarla: la transizione di riposo
  // dura 200ms e un campione preso dentro quella finestra parla dell'animazione,
  // non del gesto.
  await expect
    .poll(async () => {
      const r = await bordoDestro(page);
      return chiuso ? r <= 0 : r > 0;
    }, { message: "il cassetto deve posarsi prima che il dito lo tocchi", timeout: 5_000 })
    .toBe(true);
}

/** Il bordo destro del cassetto, in coordinate di finestra. È LA misura: a
 *  cassetto chiuso vale 0 (tutto fuori a sinistra), ad apertura piena vale la
 *  larghezza dello schermo. */
async function bordoDestro(page: Page): Promise<number> {
  return page.locator(SIDEBAR).evaluate((el) => el.getBoundingClientRect().right);
}

interface Campione { dito: number; bordo: number }

/**
 * Un trascinamento vero, campionato passo per passo.
 *
 * Fra un `touchmove` e la misura si aspettano DUE frame: il gesto scrive la
 * `transform` dentro un `requestAnimationFrame` (un solo write per frame, che è
 * il motivo per cui non sfarfalla), quindi misurare subito leggerebbe il
 * fotogramma precedente e accuserebbe il codice di un ritardo che non ha.
 */
async function trascina(
  page: Page,
  opts: { x0: number; y0: number; x1: number; passi: number; pausaMs: number; bersaglio: string | null },
): Promise<Campione[]> {
  return page.evaluate(async ({ x0, y0, x1, passi, pausaMs, bersaglio }) => {
    const nodo = (bersaglio ? document.querySelector(bersaglio) : document.body) as Element;
    const sidebar = document.querySelector('[aria-label="Topics sidebar"]') as HTMLElement;

    // IL DITO, DISEGNATO. Un tocco sintetico non lascia traccia sullo schermo, e
    // una clip in cui si vede solo il pannello scivolare non distingue «segue il
    // dito» da «un'animazione partita da sola» — cioè non prova la cosa che
    // questa spec afferma. Il cerchio è decorazione DEL TEST: `pointer-events:
    // none`, appeso al body e tolto alla fine, l'app non lo vede mai.
    const dito = document.createElement('div');
    dito.style.cssText = `position:fixed;z-index:2147483647;pointer-events:none;width:44px;height:44px;
      margin:-22px 0 0 -22px;border-radius:9999px;background:rgba(255,255,255,.35);
      border:2px solid rgba(255,255,255,.9);box-shadow:0 0 12px rgba(0,0,0,.5)`;
    document.body.appendChild(dito);
    const muoviIlDito = (x: number, y: number) => { dito.style.left = `${x}px`; dito.style.top = `${y}px`; };
    muoviIlDito(x0, y0);
    const tocco = (x: number, y: number) =>
      new Touch({ identifier: 7, target: nodo, clientX: x, clientY: y });
    const spara = (tipo: string, t: Touch, attivi: Touch[]) =>
      document.dispatchEvent(new TouchEvent(tipo, {
        bubbles: true, cancelable: true, touches: attivi, targetTouches: attivi, changedTouches: [t],
      }));
    const dueFrame = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    const attesa = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    const primo = tocco(x0, y0);
    spara("touchstart", primo, [primo]);

    const campioni: { dito: number; bordo: number }[] = [];
    for (let i = 1; i <= passi; i++) {
      const x = x0 + ((x1 - x0) * i) / passi;
      const t = tocco(x, y0);
      spara("touchmove", t, [t]);
      muoviIlDito(x, y0);
      await attesa(pausaMs);
      await dueFrame();
      campioni.push({ dito: x, bordo: sidebar.getBoundingClientRect().right });
    }
    const ultimo = tocco(x1, y0);
    spara("touchend", ultimo, []);
    // Il cerchio resta un istante dopo il rilascio: nella clip è il momento in
    // cui si vede che il pannello prosegue da solo, con la sua inerzia.
    setTimeout(() => dito.remove(), 500);
    return campioni;
  }, opts);
}

/** Il riposo dopo il rilascio: la posa dura al massimo 300ms, più il giro di
 *  React che sposta lo stato a corsa finita. */
async function posato(page: Page, aperto: boolean): Promise<void> {
  const larghezza = page.viewportSize()!.width;
  await expect
    .poll(async () => Math.round(await bordoDestro(page)), {
      message: aperto ? "il cassetto deve finire aperto" : "il cassetto deve finire chiuso",
      timeout: 5_000,
      intervals: [50, 100, 200],
    })
    .toBe(aperto ? larghezza : 0);
}

test.describe("Il cassetto mobile sta sotto il dito", () => {
  test.afterAll(async ({ request }) => {
    for (const id of creati) await deleteTopic(request, id).catch(() => {});
    creati.length = 0;
  });

  test("APERTURA: il bordo del cassetto è dove è il dito, per tutta la corsa", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "FINGER-01" });
    await apriApp(page, true);

    // Si parte dai 5px di bordo: è la striscia da cui iOS fa partire il suo
    // «indietro», ed è esattamente la striscia che questo gesto rivendica.
    const campioni = await trascina(page, { x0: 5, y0: 400, x1: 320, passi: 7, pausaMs: 20, bersaglio: null });

    // Il primo campione può essere ancora sotto la soglia d'asse (8px): lì il
    // gesto non ha ancora deciso se è uno scorrimento, e non DEVE aver mosso
    // niente. Da quando si è preso in poi, la colonna è attaccata al dito.
    for (const c of campioni.filter((c) => c.dito - 5 > 8)) {
      expect(
        Math.abs(c.bordo - c.dito),
        `col dito a ${Math.round(c.dito)} il bordo del cassetto era a ${Math.round(c.bordo)}`,
      ).toBeLessThanOrEqual(8);
    }
    // Non vacuo: se il cassetto non si fosse mai mosso, il ciclo sopra sarebbe
    // stato verde solo per un elenco vuoto.
    expect(campioni.filter((c) => c.bordo > 50).length).toBeGreaterThanOrEqual(4);

    await posato(page, true);
  });

  test("CHIUSURA: la colonna scorre col dito e se ne va con lui", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "FINGER-01" });
    await apriApp(page, false);
    const larghezza = page.viewportSize()!.width;

    const campioni = await trascina(page, { x0: 300, y0: 400, x1: 40, passi: 7, pausaMs: 20, bersaglio: SIDEBAR });

    // Chiudendo, il cassetto non sta SOTTO il dito (parte da sotto di lui e va
    // via con lui): ciò che deve valere è che si muova dello stesso spostamento,
    // pixel per pixel. È la stessa proprietà detta dall'altro lato.
    for (const c of campioni.filter((c) => 300 - c.dito > 8)) {
      const atteso = larghezza + (c.dito - 300);
      expect(
        Math.abs(c.bordo - atteso),
        `col dito a ${Math.round(c.dito)} il bordo era a ${Math.round(c.bordo)} invece che a ${Math.round(atteso)}`,
      ).toBeLessThanOrEqual(8);
    }
    expect(campioni.filter((c) => c.bordo < larghezza - 50).length).toBeGreaterThanOrEqual(4);

    await posato(page, false);
  });

  test("AL RILASCIO decide il gesto: corsa breve e LENTA non apre niente", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "FINGER-01" });
    await apriApp(page, true);

    // 90px su uno schermo da 390 sono meno di un quarto, e 120ms per passo
    // fanno una velocità di ~0.17px/ms: sotto la soglia del lancio. Il dito ha
    // aperto uno spiraglio e ci ha ripensato — il cassetto torna dov'era.
    const campioni = await trascina(page, { x0: 5, y0: 400, x1: 95, passi: 3, pausaMs: 120, bersaglio: null });
    // Durante la corsa si era mosso davvero: quello che si prova è la POSA, non
    // che il gesto sia stato ignorato.
    expect(campioni.at(-1)!.bordo).toBeGreaterThan(50);

    await posato(page, false);
  });
});

/**
 * LE TESSERE FISSATE, mentre la colonna scorre.
 *
 * `reducedMotion` torna a `no-preference` per questo blocco: tutta la suite gira
 * con «meno movimento», e `useCellFlip` in quel caso non anima NIENTE — cioè il
 * difetto sarebbe invisibile e il test verde per il motivo sbagliato.
 */
test.describe("I fissati non scattano quando la sidebar scorre", () => {
  test.use({ contextOptions: { reducedMotion: "no-preference" } });

  test.afterAll(async ({ request }) => {
    for (const id of creati) await deleteTopic(request, id).catch(() => {});
    creati.length = 0;
  });

  test("scorrimento + un render a metà: le tessere restano dove sono", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "FINGER-01" });
    // Tre fissati su una riga, e abbastanza righe sotto perché la colonna abbia
    // davvero qualcosa da scorrere.
    // La chiave di un fissato è l'id nudo del topic: è la stessa che scrive il
    // menu contestuale (vedi `sidebar-pinned-tiles.spec.ts`).
    const fissati: string[] = [];
    for (let i = 0; i < 3; i++) {
      const t = await createTopic(request, `Fissato ${i} ${Date.now()}`);
      creati.push(t.id);
      fissati.push(t.id);
    }
    for (let i = 0; i < 18; i++) {
      const t = await createTopic(request, `Riempitivo ${i} ${Date.now()}`);
      creati.push(t.id);
    }
    await request.put(`${E2E_BASE}/api/ui-state/sidebar-state`, {
      data: {
        viewMode: "timeline",
        showArchived: false,
        expandedNodes: [],
        pinnedItems: fissati,
        pinnedLayout: [{ keys: fissati, widths: fissati.map(() => 1 / 3) }],
      },
    });

    await apriApp(page, false);
    await page.waitForSelector("[data-pinned-cell]", { state: "visible", timeout: 15_000 });

    // Il contatore delle animazioni: `useCellFlip` muove una tessera chiamando
    // `cella.animate(...)`, quindi contare quelle chiamate è contare gli scatti.
    // È il numero che Attilio ha visto, non una sua approssimazione.
    await page.evaluate(() => {
      const w = window as unknown as { __scatti?: number };
      w.__scatti = 0;
      const originale = Element.prototype.animate;
      Element.prototype.animate = function (this: Element, ...args: Parameters<Element["animate"]>) {
        if (this.matches("[data-pinned-cell]")) w.__scatti = (w.__scatti ?? 0) + 1;
        return originale.apply(this, args);
      };
    });

    /** Dove sta ogni cella: nella finestra E dentro la griglia. Le due misure
     *  divergono appena la colonna scorre, ed è tutta la storia di questo bug. */
    const posizioni = () => page.evaluate(() => {
      const griglia = document.querySelector("[data-pinned-cell]")!.closest("[data-testid='sidebar-pinned-section']")
        ?? document.querySelector("[data-pinned-cell]")!.parentElement!.parentElement!;
      const base = griglia.getBoundingClientRect();
      return [...document.querySelectorAll<HTMLElement>("[data-pinned-cell]")].map((c) => {
        const r = c.getBoundingClientRect();
        return { chiave: c.dataset.pinnedCell!, finestra: r.top, griglia: r.top - base.top };
      });
    });

    const prima = await posizioni();
    expect(prima.length, "servono tessere fissate da guardare").toBe(3);

    // LO SCORRIMENTO, quello vero della colonna.
    const scorso = await page.evaluate(() => {
      let el = document.querySelector("[data-pinned-cell]")!.parentElement;
      while (el && el.scrollHeight <= el.clientHeight + 4) el = el.parentElement;
      if (!el) return 0;
      el.scrollTop = 120;
      return el.scrollTop;
    });
    expect(scorso, "la colonna deve avere davvero qualcosa da scorrere").toBeGreaterThan(0);

    // IL RENDER A METÀ SCORRIMENTO: è il pezzo che mancava per vedere il
    // difetto. Nessuno guarda le posizioni finché React non ridisegna — e una
    // tab nuova che arriva mentre scrolli è il caso più comune che c'è.
    const nuovo = await createTopic(request, `Arrivata mentre scorri ${Date.now()}`);
    creati.push(nuovo.id);
    await expect(page.getByText(nuovo.name ?? "Arrivata mentre scorri", { exact: false }).first())
      .toBeVisible({ timeout: 10_000 });

    const dopo = await posizioni();
    const scatti = await page.evaluate(() => (window as unknown as { __scatti: number }).__scatti);

    // 1) La condizione del difetto c'era davvero: in coordinate di FINESTRA le
    //    tessere si sono spostate (è ciò che il vecchio FLIP scambiava per un
    //    riordino).
    const spostamentoFinestra = Math.abs(dopo[0].finestra - prima[0].finestra);
    expect(spostamentoFinestra, "lo scorrimento deve aver mosso le tessere nella finestra").toBeGreaterThan(20);

    // 2) …e dentro la griglia non si sono mosse di un pixel.
    for (const p of prima) {
      const d = dopo.find((x) => x.chiave === p.chiave)!;
      expect(Math.abs(d.griglia - p.griglia), `la tessera ${p.chiave} si è mossa dentro la griglia`).toBeLessThan(1);
    }

    // 3) E nessuna è stata animata: zero scatti.
    expect(scatti, "nessuna tessera deve essere animata da uno scorrimento").toBe(0);
  });
});
