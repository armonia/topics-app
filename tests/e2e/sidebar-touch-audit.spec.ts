/**
 * La sidebar, MISURATA COL DITO.
 *
 * Tutto il resto della suite gira a 1280×800 con un mouse: in ogni altro test
 * `useMobile().isTouch` è FALSO, quindi long-press, menu «…», bersagli allargati
 * e la seconda riga sotto il nome non avevano UNA riga di copertura — mentre
 * l'app è usata da iPhone tutti i giorni. Questa spec gira nel progetto
 * `chromium-touch` (playwright.config.ts): `hasTouch: true` è ciò che accende
 * `navigator.maxTouchPoints`, cioè il segnale su cui l'app decide. Senza,
 * sarebbe solo una viewport stretta e proverebbe metà del problema.
 *
 * Le asserzioni sono numeri letti dal DOM (`getBoundingClientRect` +
 * `getComputedStyle`), non impressioni: una regressione si legge come un diff.
  * @covers SIDETOUCH-01
 */
import { test, expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { PAGE_LAYER_SELECTOR, SIDEBAR_SELECTOR, surfaceBg } from "./helpers/surfaces";

hermetic(test);

const BASE = E2E_BASE;
const SIDEBAR = SIDEBAR_SELECTOR;
/** Il testo che il seed manda: deve ricomparire sotto al nome della riga. */
const LAST_MESSAGE = "Questa frase deve comparire sotto al nome nella sidebar.";

/**
 * La spunta-cerchio che chiude la tab della chat, in cima. Sta FUORI dalla
 * sidebar ed è l'unica di questa famiglia che il test può misurare senza
 * seminare un terminale o un browser — le altre (`Chiudi terminale`,
 * `Chiudi browser`, `Archivia <topic>`) sono lo stesso componente con lo stesso
 * `boxClassName`, quindi qui si misura il rappresentante, non il caso isolato.
 */
const TAB_CLOSE = '[aria-label^="Chiudi tab"]';

/**
 * LE SEI VOCI del menu della riga chat (`client/src/components/Modals/ContextMenu.tsx`,
 * ramo `subMenu === 'none'`). Scritte per esteso e non contate, perché «sei voci»
 * resterebbe vero anche se una fosse sostituita da un'altra.
 *
 * Le ultime due sono quelle che pesano: FISSA e ARCHIVIA erano il contenuto del
 * «…» che è stato rimosso da touch. Se il gesto le apre, togliere il bottone non
 * ha tolto un comando a nessuno — ed è esattamente ciò che SIDEBAR-TOUCH-02 deve
 * poter dimostrare, invece di limitarsi a constatare un'assenza.
 */
const MENU_VOICES = [
  "Rinomina",
  "Cambia colore",
  "Copia link",
  "Apri in nuova finestra",
  "Fissa",
  "Archivia",
] as const;

/** Alias locale: le chiamate qui sotto misurano tutte lo stesso `background-color`. */
const bg = surfaceBg;

/**
 * SU MOBILE IL CASSETTO NASCE APERTO O CHIUSO A SECONDA DI COSA C'È DA RIAPRIRE
 * (`useSidebarAndLayout`: `isMobile ? hasVisiblePane(…) : …`, dal 07/08 —
 * «appena apro Topics dovrei aprire l'ultima tab che ho lasciato aperta; se no
 * di default dovrei trovarmi sulla sidebar»). Quindi l'helper condiviso
 * `goToApp` non serve — aspetta la colonna VISIBILE e andrebbe in timeout su un
 * cassetto tradotto fuori schermo — e nemmeno una ⌘B secca serve: era corretta
 * finché lo stato iniziale era UNO SOLO, e questi helper premevano
 * l'interruttore alla cieca. Adesso guardano prima dove sono.
 *
 * L'auto-collapse è agganciato al CAMBIO di `isMobile`, non allo stato, quindi
 * una volta aperta resta aperta.
 */
/** Il cassetto è dentro lo schermo? Chiuso ha larghezza 0 (`width: 0` +
 *  `translateX(-100%)`), quindi non ha un box che Playwright consideri visibile
 *  — la larghezza è la domanda, non l'ascissa. */
async function sidebarIsOpen(page: Page): Promise<boolean> {
  const box = await page.locator(SIDEBAR).boundingBox();
  return !!box && box.width > 0 && box.x + box.width > 0;
}

async function openSidebarOnPhone(page: Page) {
  await page.request
    .put(`${BASE}/api/ui-state/panel-order`, { data: { order: [], pinned: [] } })
    .catch(() => {});
  await page.goto("/");
  // ⌘B, non il bottone del pannello: i bottoni che aprono e chiudono la colonna
  // sono DUE (`Expand sidebar (⌘B)` fuori, `Close sidebar` dentro) e il primo in
  // ordine di DOM è quello DENTRO la sidebar chiusa — fuori dal viewport, quindi
  // impossibile da toccare. La scorciatoia è la stessa azione senza la caccia
  // all'elemento giusto; il gesto col dito è ciò che i test SOTTO verificano,
  // qui si sta solo apparecchiando.
  await page.locator(SIDEBAR).waitFor({ state: "attached", timeout: 20_000 });
  // L'interruttore si preme SOLO se serve: con zero tab da riaprire il cassetto
  // è già aperto, e una ⌘B alla cieca lo richiuderebbe — poi il resto
  // dell'helper aspetterebbe per venti secondi che diventi visibile qualcosa
  // che si è appena chiuso per colpa sua.
  if (!(await sidebarIsOpen(page))) await page.keyboard.press("ControlOrMeta+b");
  await page.waitForSelector(SIDEBAR, { state: "visible", timeout: 20_000 });
  // E POI SI ASPETTA CHE SIA FERMA. «Visible» per Playwright vuol dire «ha un
  // box e non è display:none» — e la sidebar mobile entra con una `translateX`
  // (`sidebar-transition`), quindi è "visibile" per tutta la scivolata mentre il
  // suo bordo sinistro è ancora fuori schermo.
  //
  // Misurato: SIDEBAR-TOUCH-03 falliva 2 volte su 10 con `sidebarX=-71` e
  // `-84`, e il centro del bersaglio a `cx=-1` — fuori dal viewport, dove
  // `elementFromPoint` restituisce `null`. Non era un difetto del prodotto e non
  // era «lentezza»: era una misura geometrica presa su un layout in movimento.
  // Ogni test di questo file misura rettangoli, quindi la condizione sta qui,
  // una volta sola, e vale per tutti.
  await expect
    .poll(async () => Math.round((await page.locator(SIDEBAR).boundingBox())?.x ?? -999), {
      message: "la sidebar deve finire di entrare prima di misurare qualsiasi cosa",
      timeout: 5_000,
      intervals: [50, 100, 200],
    })
    .toBe(0);
}

/**
 * E POI LA RICHIUDE — perché su un telefono la colonna è un CASSETTO che copre
 * tutto, e finché è aperta la barra delle tab non è raggiungibile da nessun dito.
 *
 * Non è un dettaglio di comodo, è la ragione per cui SIDEBAR-TOUCH-03 è nato
 * rosso: misurava la spunta di chiusura della tab con la colonna ancora aperta e
 * si sentiva rispondere che il suo centro apparteneva a qualcun altro. Verissimo
 * — apparteneva al cassetto. La misura era presa in uno stato in cui quel
 * bersaglio non esiste per l'utente, e avrebbe accusato il componente sbagliato.
 *
 * Perciò i bersagli della sidebar si misurano col cassetto APERTO e quelli della
 * barra in cima col cassetto CHIUSO: sono due stati che non si sovrappongono mai
 * davvero, e misurarli insieme proverebbe una schermata che non esiste.
 */
async function closeSidebarOnPhone(page: Page) {
  if (await sidebarIsOpen(page)) await page.keyboard.press("ControlOrMeta+b");
  // Come all'apertura: «invisibile» arriva PRIMA che la scivolata sia finita, e
  // qui si sta per misurare ciò che stava sotto. Si aspetta che la colonna sia
  // uscita per intero dal viewport (bordo destro a sinistra dello zero), non che
  // abbia cominciato ad andarsene.
  await expect
    .poll(async () => {
      const box = await page.locator(SIDEBAR).boundingBox();
      return !box || Math.round(box.x + box.width) <= 0;
    }, {
      message: "il cassetto deve uscire del tutto prima di misurare ciò che copriva",
      timeout: 5_000,
      intervals: [50, 100, 200],
    })
    .toBe(true);
}

/**
 * Tiene premuto DAVVERO: Playwright non ha una primitiva «touch and hold», e
 * `dispatchEvent` con oggetti letterali non basta — React legge
 * `e.touches[0].clientX`, e la lista dei tocchi vuole veri oggetti `Touch`
 * (identifier + target), altrimenti l'handler riceve `undefined` e il gesto non
 * parte mai. Quindi gli eventi si costruiscono nella pagina.
 * La pausa è oltre i 500 ms di `LONG_PRESS_MS`, e il dito non si muove: sotto i
 * 10 px di slop il gesto sopravvive comunque, ma qui si prova il caso pulito.
 */
async function longPress(page: Page, selector: string, ms = 750) {
  await page.locator(selector).first().evaluate((el, hold) => {
    const r = el.getBoundingClientRect();
    const x = r.x + r.width / 2;
    const y = r.y + r.height / 2;
    const touch = new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
    const fire = (type: string, touches: Touch[]) =>
      el.dispatchEvent(new TouchEvent(type, {
        bubbles: true,
        cancelable: true,
        touches,
        targetTouches: touches,
        changedTouches: [touch],
      }));
    fire("touchstart", [touch]);
    return new Promise<void>((resolve) => {
      setTimeout(() => { fire("touchend", []); resolve(); }, hold);
    });
  }, ms);
}

/**
 * SOLLEVA E TRASCINA, col dito vero.
 *
 * Come `longPress`, ma il gesto non finisce alla pressione: dopo i 500 ms si
 * muove il tocco fino a `verso` e poi lo si stacca. I `touchmove` sono NATIVI e
 * costruiti nella pagina per la stessa ragione del cugino qui sopra (React
 * legge `e.touches[0].clientX`, e serve un vero oggetto `Touch`) — e devono
 * partire da `document`, perché la fase di trascinamento di `useTouchDrag` si
 * aggancia lì in CATTURA: un evento lanciato solo sull'elemento non passerebbe
 * mai dal listener che lo serve.
 *
 * Il movimento è a PASSI, non un salto: la griglia risolve il bersaglio a ogni
 * `touchmove`, e un unico balzo proverebbe una cosa che il dito non fa mai.
 */
async function longPressDrag(page: Page, selector: string, dx: number, dy: number, passi = 8, hold = 900) {
  await page.locator(selector).first().evaluate(async (el, { dx, dy, passi, hold }) => {
    const r = el.getBoundingClientRect();
    const x0 = r.x + r.width / 2;
    const y0 = r.y + r.height / 2;
    const tocco = (x: number, y: number) => new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
    const fire = (target: EventTarget, type: string, t: Touch, attivi: Touch[]) =>
      target.dispatchEvent(new TouchEvent(type, {
        bubbles: true, cancelable: true, touches: attivi, targetTouches: attivi, changedTouches: [t],
      }));
    const attesa = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    const primo = tocco(x0, y0);
    fire(el, "touchstart", primo, [primo]);
    // Oltre LONG_PRESS_MS con margine: sotto carico (quattro shard sulla stessa
    // macchina) un'attesa di poco superiore ai 500ms arriva a scadere DOPO che
    // il primo `touchmove` è già partito, e allora il gesto viene letto come
    // uno scorrimento e annullato — il test diventava flaky per il tempo, non
    // per il prodotto.
    await attesa(hold);
    for (let i = 1; i <= passi; i++) {
      const t = tocco(x0 + (dx * i) / passi, y0 + (dy * i) / passi);
      fire(document, "touchmove", t, [t]);
      await attesa(24);
    }
    // UN RESPIRO PRIMA DI STACCARE. Il posto in cui la tessera atterra si
    // ricalcola dal DOM al rilascio, e il DOM sta mostrando l'ANTEPRIMA del
    // riordino: se si stacca nello stesso frame dell'ultimo movimento, sotto
    // carico si misura un layout che React non ha ancora applicato. Un dito
    // vero questa pausa ce l'ha sempre.
    const ultimo = tocco(x0 + dx, y0 + dy);
    fire(document, "touchmove", ultimo, [ultimo]);
    await attesa(120);
    fire(document, "touchend", ultimo, []);
  }, { dx, dy, passi, hold });
}

/**
 * Aspetta che le tessere siano FERME prima di misurarle.
 *
 * La griglia riconcilia il layout salvato con i fissati che arrivano dal
 * server (`reconcilePinnedLayout`), e per un frame o due le celle si assestano.
 * Misurare lì dentro dà coordinate che non varranno più — e il trascinamento
 * parte da quelle. Due letture identiche di fila = layout fermo.
 */
async function attendiTessereFerme(page: Page) {
  const leggi = () => page.getByTestId("pinned-tile").evaluateAll((els) =>
    els.map((e) => { const r = e.getBoundingClientRect(); return `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)}`; }).join("|"));
  let prec = await leggi();
  await expect
    .poll(async () => {
      const ora = await leggi();
      const fermo = ora === prec && ora !== "";
      prec = ora;
      return fermo;
    }, { message: "le tessere fissate non si fermano: misurarle darebbe coordinate stantie", timeout: 10_000, intervals: [100, 150, 200] })
    .toBe(true);
}

/**
 * IL BERSAGLIO VERO, NON IL SUO BOX.
 *
 * `getBoundingClientRect()` misura il rettangolo di LAYOUT, e sui comandi di
 * questa app quel numero mente in tutte e due le direzioni:
 *
 *  · per DIFETTO, perché `.tap-expand-y` allarga l'area sensibile con un
 *    `::after` che nel rect del bottone non compare: la X di una tab misura
 *    28×28 di box e se ne prende 36 di altezza;
 *  · per ECCESSO, perché un box grande di cui un vicino copre il centro non è
 *    un bersaglio — è la trappola che `.tap-expand` aveva già pagato (44 di
 *    largo sopra il glifo del pin: toccare il pin chiudeva il browser).
 *
 * Quindi si misura come misura un dito: si parte dal centro e si cresce in
 * croce finché `elementFromPoint` risponde ancora «sono io» (o un mio
 * discendente — l'`svg` dentro il bottone). Quello che torna è la larghezza e
 * l'altezza REALI del bersaglio, `::after` compreso e occlusioni comprese.
 *
 * `hit.contains(el)` NON va messo, mai: se a rispondere è un ANTENATO (la riga)
 * il tocco finisce sulla riga invece che sul comando, ed è esattamente il
 * difetto che si sta cercando. Con quel ramo il test sarebbe verde per
 * costruzione.
 */
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

test.describe.configure({ mode: "serial" });

test.describe("Sidebar col dito — audit misurato", () => {
  let topicId: string;
  let topicName: string;

  test.beforeAll(async ({ request }) => {
    topicName = `touch-audit-${Date.now()}`;
    const topic = await createTopic(request, topicName);
    topicId = topic.id;
    await request.post(`${BASE}/api/topics/${topicId}/system-message`, {
      data: { content: LAST_MESSAGE },
      ignoreHTTPSErrors: true,
    });
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
    // L'anteprima arriva da `GET /api/topics/previews`, che il client chiama UNA
    // volta al boot. Se il messaggio seminato non è ancora visibile a
    // quell'endpoint quando la pagina si carica, la riga nasce muta e nessun
    // re-render la riempie: la fetch è già passata.
    //
    // Non è un'attesa di comodo — è la PRECONDIZIONE del test, e si aspetta la
    // condizione vera invece di sperare in un timeout più lungo. (Misurato:
    // SUBLINE-01 falliva ~2 volte su 8 con l'endpoint che rispondeva 200 ma
    // senza questa chiave. L'endpoint ha una cache a 5s validata su
    // `max(rowid)+count(*)` di `messages`: subito dopo il seed la finestra in
    // cui può ancora servire la fotografia precedente esiste.)
    await expect
      .poll(async () => {
        const r = await request.get(`${BASE}/api/topics/previews`, { ignoreHTTPSErrors: true });
        if (!r.ok()) return false;
        const body = (await r.json()) as { previews?: Record<string, { text?: string }> };
        return !!body.previews?.[topicId]?.text;
      }, {
        message: "il server deve poter servire l'anteprima del topic prima che la pagina la chieda",
        timeout: 10_000,
        intervals: [100, 200, 400, 800],
      })
      .toBe(true);
  });

  /**
   * SU UN TELEFONO C'È UNA SUPERFICIE SOLA.
   *
   * Il difetto che ha aperto tutto questo: su iPhone la fascia in cima cambiava
   * colore aprendo e chiudendo la sidebar (`--bg-surface` contro `--bg`), e i
   * due estremi della stessa colonna avevano due token diversi — sopra
   * `bg-surface`, sotto `bg-app-bg`.
   *
   * La cura è arrivata fino in fondo: sotto i 768px `--bg` e `--bg-surface`
   * collassano su `--chrome-bg` (index.css, `@media (max-width: 767px)`), perché
   * a 390×844 le tre superfici NON stanno una accanto all'altra — stanno
   * impilate, ognuna al 100% dello schermo, e se ne vede una per volta. Un
   * gradino che non si può vedere accanto al suo vicino non separa niente: si
   * manifesta solo come «lo sfondo è più chiaro della sidebar».
   *
   * Quindi qui si pretende UNA COSA SOLA: colonna, fascia della safe-area, fondo
   * dell'app e piano delle pane sono lo STESSO pixel. La gerarchia «il chrome sta
   * un gradino SOTTO la pagina» non è morta — è un'invariante da DESKTOP, dove le
   * superfici si vedono affiancate, e vive dove è vera: `sidebar.spec.ts`,
   * «SIDEBAR-SURFACES-01», a 1280×800.
   */
  test("SIDEBAR-CHROME-01: la colonna, la fascia e il piano delle pane sono lo stesso pixel", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "SIDETOUCH-01" });
    await openSidebarOnPhone(page);

    const chrome = await bg(page, SIDEBAR);
    // Il perno di tutte le uguaglianze qui sotto: se la colonna non dipingesse
    // nulla, «tutto è uguale al chrome» sarebbe vero per vuoto — quattro
    // trasparenti che coincidono, e il test verde su un'app senza colore.
    expect(
      chrome,
      `la colonna non dipinge un colore opaco (${chrome}): le uguaglianze qui sotto sarebbero vere per vuoto`,
    ).toMatch(/^rgb\(\d+, \d+, \d+\)$/);

    // SUL TELEFONO LA FASCIA DI STATO NON C'È PIÙ (12/08): «è qualcosa che
    // l'utente raramente utilizzerà», e le sue tre cose — chi sei, come va, che
    // versione è — stanno nel menu «Topics». Quello che questa clausola
    // proteggeva resta vero e si pretende ancora, spostato su chi ha preso il
    // suo posto: DENTRO la colonna nessuno dà una seconda mano di colore, che
    // sotto Tauri comporrebbe l'alpha della vibrancy sopra la prima (0,80
    // contro 0,55). La fila dei comandi in fondo dipinge, ma è un FRATELLO
    // della colonna, non un suo figlio — ed è per questo che può.
    await expect(page.locator(`${SIDEBAR} [data-testid="sidebar-status-bar"]`)).toHaveCount(0);
    const queueOutside = await page.evaluate(() => {
      const colonna = document.querySelector('[role="navigation"][aria-label="Topics sidebar"]');
      const fila = document.querySelector('[data-testid="mobile-chrome-bar"]');
      return { esiste: !!fila, dentro: !!(colonna && fila && colonna.contains(fila)) };
    });
    expect(queueOutside.esiste).toBe(true);
    expect(queueOutside.dentro).toBe(false);

    // LA FASCIA DELLA SAFE-AREA È LO STESSO PIXEL DELLA SIDEBAR.
    // È il difetto che ha riaperto la questione: la striscia sotto la tacca è il
    // `paddingTop` di `#main-content`, dipinto dal background di QUELL'elemento —
    // che era il colore della PAGINA, mentre la sidebar dipinge il CHROME. A
    // drawer chiuso la striscia era chiara, ad aperto scura: due tinte per la
    // stessa striscia. Ora il colore della pagina sta sul FIGLIO e la fascia è
    // chrome; qui si pretende che i due valori coincidano esattamente.
    const fascia = await bg(page, "#main-content");
    expect(fascia, `la fascia della safe-area (${fascia}) deve essere lo stesso pixel della sidebar (${chrome})`).toBe(chrome);
    // E il fondo di ultima istanza — quello che si vede al bordo dell'app —
    // dice la stessa cosa.
    const backdrop = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(backdrop, `il fondo dell'app (${backdrop}) deve essere il chrome (${chrome})`).toBe(chrome);

    // E IL PIANO DELLE PANE È LO STESSO PIXEL, non un gradino sopra.
    // Qui stava `luminance(chrome) < luminance(pagina)`, ereditato dal desktop.
    // Con le superfici collassate quell'asserzione non poteva che essere falsa
    // (misurato: entrambe rgb(234, 236, 240), L=0.8377 contro L=0.8377) — e se
    // un domani si allentasse a `<=` sarebbe peggio, perché passerebbe SIA sul
    // collasso voluto SIA su una regressione che riapre il gradino nella
    // direzione sbagliata. L'uguaglianza esatta è l'unica forma che dice la
    // cosa giusta: qualunque scarto, in qualunque verso, è la regressione.
    const pagina = await bg(page, PAGE_LAYER_SELECTOR);
    expect(
      pagina,
      `il piano delle pane (${pagina}) deve essere lo stesso pixel della colonna (${chrome}): sotto i 768px le superfici collassano`,
    ).toBe(chrome);
  });

  /**
   * UN RITMO SOLO. Prima la riga chat era 40px e ogni altra 44, e utility e
   * board restavano 32 anche su iPhone — sotto il minimo di tap target e 12px
   * più basse delle vicine. Qui si pretende che ogni riga dell'albero abbia la
   * STESSA altezza e lo STESSO bordo sinistro: il ritmo verticale non salta a
   * ogni cambio di tipo, e la colonna del testo è una.
   */
  test("SIDEBAR-CHROME-02: tutte le righe hanno la stessa altezza (44) e lo stesso bordo sinistro", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "SIDETOUCH-01" });
    await openSidebarOnPhone(page);
    const rows = page.locator(`${SIDEBAR} [role="treeitem"]`);
    await expect(rows.first()).toBeVisible({ timeout: 10_000 });

    const geom = await rows.evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return { h: Math.round(r.height), x: Math.round(r.x), label: el.getAttribute("aria-label") ?? "" };
      }),
    );
    expect(geom.length, "nessuna riga misurata: il test sarebbe verde per vuoto").toBeGreaterThan(0);

    const heights = [...new Set(geom.map((g) => g.h))];
    expect(heights, `altezze diverse fra le righe: ${JSON.stringify(geom)}`).toEqual([44]);

    const lefts = [...new Set(geom.map((g) => g.x))];
    expect(lefts, `bordi sinistri disallineati: ${JSON.stringify(geom)}`).toHaveLength(1);
  });

  /**
   * LA RIGA DICE SEMPRE QUALCOSA. `SessionActivity` si auto-nasconde appena la
   * sessione è ferma — cioè quasi sempre — e la riga restava muta: per sapere di
   * cosa parlasse una chat bisognava aprirla. Qui la sessione è ferma per
   * costruzione (nessun turno in corso), quindi sotto al nome deve esserci
   * l'ultimo messaggio.
   */
  test("SIDEBAR-SUBLINE-01: a sessione ferma sotto al nome c'è l'ultimo messaggio", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "SIDETOUCH-01" });
    await openSidebarOnPhone(page);
    const row = page.getByRole("treeitem", { name: topicName });
    await expect(row).toBeVisible({ timeout: 10_000 });

    const preview = row.locator('[data-testid="topic-preview"]');
    await expect(preview).toBeVisible({ timeout: 10_000 });
    await expect(preview).toHaveText(new RegExp(LAST_MESSAGE.slice(0, 40)));
  });

  /**
   * TENERE PREMUTO APRE IL MENU VERO — quello a sei voci del tasto destro, non
   * un secondo menu touch con un sottoinsieme. «Rinomina» è la sentinella: era
   * una delle quattro voci (con Cambia colore, Copia link, Apri in nuova
   * finestra) che da iPhone erano semplicemente IRRAGGIUNGIBILI.
   */
  test("SIDEBAR-TOUCH-01: tenere premuto apre il menu completo, non un suo sottoinsieme", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "SIDETOUCH-01" });
    await openSidebarOnPhone(page);
    const row = page.getByRole("treeitem", { name: topicName });
    await expect(row).toBeVisible({ timeout: 10_000 });

    await longPress(page, `[role="treeitem"][aria-label="${topicName}"]`);
    await expect(page.getByText("Rinomina", { exact: true })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Copia link", { exact: true })).toBeVisible();
  });

  /**
   * IL «…» NON C'È PIÙ, E IL GESTO NON HA PERSO NIENTE.
   *
   * Questo test diceva l'OPPOSTO fino a ieri («il bottone resta perché un gesto
   * nascosto non si scopre») ed è stato girato per una decisione di Attilio:
   * «da mobile non c'è bisogno di mettere il menu a 3 puntini visto che c'è il
   * long press». Il gesto è ormai lo standard di tutta l'app — righe, tab,
   * gruppi, tessere, messaggi — e si impara una volta sola; un promemoria
   * stampato su ogni riga è rumore.
   *
   * Le due metà vanno INSIEME, e separate non varrebbero niente:
   *
   *  · l'ASSENZA da sola passerebbe anche se il menu l'avessimo rotto — anzi,
   *    passerebbe pure su una riga che non risponde più a niente. È l'asserzione
   *    che non può fallire per il motivo giusto;
   *  · la PRESENZA del menu da sola è già SIDEBAR-TOUCH-01.
   *
   * Perciò qui si pretende che sparisca la porta ridondante E che dietro il
   * gesto ci sia ancora la stanza intera: le due voci che il «…» non aveva mai
   * avuto (Rinomina, Copia link) e — soprattutto — quelle che invece OFFRIVA
   * (Fissa, Archivia), che sono la prova che togliendolo non si è perso nulla.
   */
  test("SIDEBAR-TOUCH-02: col dito il «…» non c'è, e il gesto apre comunque il menu intero", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "SIDETOUCH-01" });
    await openSidebarOnPhone(page);
    const row = page.getByRole("treeitem", { name: topicName });
    await expect(row).toBeVisible({ timeout: 10_000 });

    // METÀ UNO — la porta ridondante non c'è, né col suo nome né sotto mentite
    // spoglie: qualunque apri-menu nella riga conterebbe come «il «…» è tornato».
    await expect(
      row.getByRole("button", { name: `Azioni per ${topicName}` }),
      "il «…» è tornato nel binario: col dito la porta è il gesto, non un bottone",
    ).toHaveCount(0);
    await expect(
      row.locator('[aria-haspopup="menu"]'),
      "c'è un apri-menu nella riga sotto un altro nome",
    ).toHaveCount(0);

    // METÀ DUE — e dietro il gesto c'è ancora tutto.
    await longPress(page, `[role="treeitem"][aria-label="${topicName}"]`);
    for (const voce of MENU_VOICES) {
      await expect(
        page.getByText(voce, { exact: true }),
        `«${voce}» non è nel menu del gesto: togliendo il «…» si è perso un comando`,
      ).toBeVisible({ timeout: 5_000 });
    }
  });

  /**
   * I BERSAGLI NON SI MANGIANO A VICENDA. `.tap-expand` proietta 44×44 attorno a
   * un glifo da 24: nel binario in coda alla riga due aree così, con i centri a
   * 32px, si sovrappongono di 12 e vince l'ultimo nel DOM — il bordo del «…»
   * attivava il vicino. La correzione è `.tap-expand-y` (cresce solo in altezza)
   * più un box reale più grande. Qui si misura il punto centrale di ogni
   * bersaglio e si pretende che colpisca SE STESSO.
   *
   * IL CAMPIONE SI È ALLARGATO, e non per completezza: era diventato VUOTO.
   * Questo test guardava i `<button>` DENTRO la riga della chat, e l'unico che
   * ci fosse era il «…» — tolto quello (SIDEBAR-TOUCH-02), su una chat non
   * archiviata e senza figli restano zero bottoni, e la rete «almeno uno,
   * altrimenti è verde per vuoto» sarebbe scattata su un fatto sano invece che
   * su una regressione. Abbassarla a `>= 0` sarebbe stato il modo peggiore di
   * farlo passare: avrebbe spento l'unica asserzione che teneva in piedi il
   * test.
   *
   * Quindi si misura ciò che col dito è DAVVERO toccabile: tutti i bottoni di
   * tutte le righe dell'albero (progetti, sezioni, chat archiviate: quelle un
   * binario ce l'hanno ancora) più la spunta-cerchio che chiude la tab in cima.
   * Le due famiglie stanno nello stesso test perché è la stessa domanda — «il
   * centro di questo bersaglio appartiene a lui?» — e perché la seconda è
   * proprio quella che il brief chiama in causa.
   */
  test("SIDEBAR-TOUCH-03: ogni bersaglio col dito colpisce sé stesso", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "SIDETOUCH-01" });
    await openSidebarOnPhone(page);
    const row = page.getByRole("treeitem", { name: topicName });
    await expect(row).toBeVisible({ timeout: 10_000 });
    // LA STRISCIA DELLE TAB SUL TELEFONO NON C'E' PIU'. Era l'altra metà del
    // campione; da quando la colonna a schermo intero È l'elenco delle superfici
    // aperte, una seconda copia in cima ripeteva destinazioni che ci sono già e
    // si prendeva 46px su 844. Qui si misura ciò che c'è: le righe dell'albero.
    // La spunta-cerchio della tab resta col mouse (`row-actions-overlay`), e il
    // suo posto sul telefono lo prendono le quattro porte in basso, misurate
    // in `mobile-chrome-bar.spec.ts` (MOBILE-CHROME-02, soglia 44px).

    // LE DUE FAMIGLIE NON SI POSSONO MISURARE NELLO STESSO ISTANTE, e non è una
    // pignoleria di test: sotto i 768px la colonna è un DRAWER a tutto schermo e
    // la barra delle tab ci finisce SOTTO. Misurate insieme, la X della tab
    // risulterebbe sempre «rubata» — dalla sidebar aperta sopra di lei — con un
    // box perfettamente regolare: 28×28 e centro alla sidebar. (Misurato: è il
    // rosso che questo test dava appena il campione si è allargato alle tab, e
    // non era un difetto del prodotto.) Ognuna si misura nello stato in cui la
    // si usa: la colonna aperta, le tab con la colonna chiusa.
    const misura = (selettori: string[]) => page.evaluate((sels) => {
      const targets = sels.flatMap((s) => [...document.querySelectorAll(s)]) as HTMLElement[];
      return targets.map((el) => {
        const r = el.getBoundingClientRect();
        const cx = r.x + r.width / 2;
        const cy = r.y + r.height / 2;
        const hit = document.elementFromPoint(cx, cy);
        return {
          label: el.getAttribute("aria-label") ?? el.className.slice(0, 30),
          w: Math.round(r.width),
          h: Math.round(r.height),
          // `hit.contains(el)` NON va messo: farebbe passare il caso peggiore.
          // Se `elementFromPoint` restituisce un ANTENATO (la riga stessa), vuol
          // dire che il centro del bersaglio e' coperto da qualcos'altro e il tocco
          // finisce sulla riga invece che sul comando — cioe' proprio «il bordo del
          // bersaglio attiva la chat invece del suo comando». Con quel ramo il test
          // sarebbe verde per costruzione: il bersaglio possiede il suo centro solo
          // se a colpirlo e' lui o un suo discendente (l'svg dentro il bottone).
          ownsItsCentre: !!hit && (el === hit || el.contains(hit)),
        };
      })
      // Un bersaglio che non è dipinto non è un bersaglio: i box a zero (le
      // azioni che su desktop compaiono all'hover e qui restano non montate) non
      // hanno un centro da possedere e falserebbero il conto in entrambi i versi.
      .filter((t) => t.w > 0 && t.h > 0);
    }, selettori);

    const verdict = await misura([`${SIDEBAR} [role="treeitem"] button`]);
    await closeSidebarOnPhone(page);
    // E la striscia non ricompare a colonna chiusa: è la meta' del brief che
    // questo test tiene ferma, non un effetto collaterale della sidebar aperta.
    await expect(page.locator(TAB_CLOSE)).toHaveCount(0);

    expect(verdict.length, "nessun bersaglio misurato: il test sarebbe verde per vuoto").toBeGreaterThan(0);
    const stolen = verdict.filter((v) => !v.ownsItsCentre);
    expect(stolen, `bersagli il cui centro è rubato da un altro: ${JSON.stringify(verdict)}`).toEqual([]);

  });

  /**
   * IL GESTO CHIEDE UNA MICRO-VIBRAZIONE — e non lascia clandestini nel DOM.
   *
   * Due affermazioni in un test solo, perché sono le due metà della stessa
   * questione (vedi il blocco in cima a `client/src/lib/haptics.ts`):
   *
   *  1. DOVE IL DISPOSITIVO SA VIBRARE, LA PULSAZIONE PARTE. Chromium headless
   *     non ha un motore aptico, quindi qui la Vibration API viene INSTALLATA
   *     dal test: non si prova che il telefono vibri — impossibile in una suite
   *     — si prova che il «tieni premuto» arrivi fino a `navigator.vibrate` con
   *     la durata giusta, che è il solo pezzo che dipende da noi. Il ramo
   *     opposto (iPhone: la funzione non esiste, `haptic()` torna `false` in
   *     silenzio senza rompere il gesto) è coperto dai test unitari in
   *     `client/src/lib/haptics.test.ts`.
   *
   *  2. NESSUN ELEMENTO DI SERVIZIO. Il ripiego che si trova cercando «haptic
   *     feedback iOS web» è uno `<input type="checkbox" switch>` nascosto,
   *     sovrapposto al bersaglio e toccato al posto suo. Qui NON esiste — è
   *     morto in iOS 26.5 e comunque ruberebbe il tocco alla riga e metterebbe
   *     una checkbox nell'albero di accessibilità di ogni superficie che si può
   *     tenere premuta. Questa metà del test è ciò che impedisce che rientri di
   *     soppiatto: nessun `input[switch]` nel documento, e nessuna checkbox
   *     invisibile o fuori schermo.
   */
  test("SIDEBAR-TOUCH-04: il gesto chiede la micro-vibrazione, senza elementi di servizio nascosti", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "SIDETOUCH-01" });
    await page.addInitScript(() => {
      const w = window as unknown as { __vibrate: number[]; __hadVibrate: boolean };
      w.__vibrate = [];
      // Si annota se l'API c'era GIÀ: se un domani Chromium smettesse di averla,
      // questo test resterebbe verde comunque (la installa lui) e la nota nel
      // messaggio d'errore dice da dove viene.
      w.__hadVibrate = typeof navigator.vibrate === "function";
      Object.defineProperty(Navigator.prototype, "vibrate", {
        configurable: true,
        value(pattern: number | number[]) {
          w.__vibrate.push(...(Array.isArray(pattern) ? pattern : [pattern]));
          return true;
        },
      });
    });

    await openSidebarOnPhone(page);
    const row = page.getByRole("treeitem", { name: topicName });
    await expect(row).toBeVisible({ timeout: 10_000 });

    await longPress(page, `[role="treeitem"][aria-label="${topicName}"]`);

    // Il menu aperto è la PRECONDIZIONE, non un extra: senza, un `__vibrate`
    // vuoto non distinguerebbe «non ha vibrato» da «il long-press non è nemmeno
    // partito», e il test fallirebbe (o passerebbe) parlando della cosa sbagliata.
    await expect(page.getByText("Rinomina", { exact: true })).toBeVisible({ timeout: 5_000 });

    const probe = await page.evaluate(() => {
      const w = window as unknown as { __vibrate: number[]; __hadVibrate: boolean };
      return { pulses: w.__vibrate, hadVibrate: w.__hadVibrate };
    });
    // 20ms = `haptic('medium')`, il livello che `useLongPress` chiede quando il
    // gesto scatta. Un array vuoto vuol dire che la chiamata si è persa per
    // strada; un numero diverso, che i livelli sono cambiati sotto ai piedi.
    expect(
      probe.pulses,
      `il «tieni premuto» deve chiedere una pulsazione da 20ms (Vibration API nativa presente: ${probe.hadVibrate})`,
    ).toEqual([20]);

    // E QUI L'ASSERZIONE È CAMBIATA, perché è cambiato il prodotto (07/08).
    //
    // Prima diceva: «uno `<input switch>` non ha nessuna ragione di esistere in
    // questa app, qualunque occorrenza è il trucco iOS rientrato dalla
    // finestra». Non è più vero: su iOS 17.4–26.4 quel controllo è l'UNICA
    // strada per la micro-vibrazione, e ora `haptic()` lo crea apposta
    // (client/src/lib/haptics.ts). Lasciata com'era, quella riga sarebbe
    // rimasta VERDE — questo browser non è un iPhone, quindi l'elemento non
    // nasce comunque — mentre asseriva il contrario di ciò che il codice fa:
    // un verde che descrive un prodotto che non esiste più.
    //
    // L'invariante VERA, e quella che serve: fuori da iOS non nasce NIENTE. Un
    // elemento di servizio su un desktop sarebbe peso senza contropartita, e
    // sarebbe anche il segno che il ramo iOS si è slegato dal suo `if`. Che su
    // iPhone l'elemento sia inerte (aria-hidden, tabIndex -1, non toccabile,
    // uno solo, stato pulito) lo provano i test unitari di `haptics.test.ts`,
    // dove lo user-agent si può fingere; qui non si può.
    const stowaways = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLInputElement>('input[switch], input[type="checkbox"]')]
        .filter((el) => {
          if (el.hasAttribute("switch")) return true;
          // Una checkbox VERA e visibile (le impostazioni della board) è
          // legittima; una invisibile o parcheggiata fuori schermo è la firma di
          // un controllo di servizio.
          const r = el.getBoundingClientRect();
          return r.width === 0 || r.height === 0 ||
            r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight;
        })
        .map((el) => ({ type: el.type, isSwitch: el.hasAttribute("switch"), cls: el.className.slice(0, 40) })),
    );
    expect(
      stowaways,
      "fuori da iOS `haptic()` non deve creare nessun elemento di servizio: qui lo user-agent non è un iPhone, quindi il ramo iOS non deve nemmeno essere entrato (vedi iosSwitchPulse in client/src/lib/haptics.ts)",
    ).toEqual([]);
  });

  /**
   * DOVE STANNO LE COSE NELLA COLONNA, col dito — RISCRITTA IL 12/08.
   *
   * Ha girato per un giorno intero, e la storia resta scritta perché il test
   * serve proprio a non rifarla: la barra di stato è andata in una fascia sua
   * sotto l'header, poi in linea nella riga del titolo, poi IN FONDO alla
   * colonna con l'identità attaccata sopra. Cerca e «+» sono stati in una barra
   * in fondo, poi attaccati al logo, poi allineati a destra nella riga del
   * titolo.
   *
   * La forma decisa da Attilio (12/08) chiude il giro e cambia la risposta a
   * entrambe le domande:
   *  · IN ALTO, «da un lato topics, cliccabile; dall'altro nient'altro»;
   *  · IN BASSO, tre porte — cerca · aggiungi · board — in una fila che non
   *    appartiene alla colonna ma allo schermo, così resta sotto le dita anche
   *    a cassetto chiuso;
   *  · la barra di stato non c'è più: statistiche e versione sono nel menu
   *    «Topics», «è qualcosa che l'utente raramente utilizzerà».
   *
   * Si misura l'APPARTENENZA e l'ORDINE, non le classi.
   */
  test("SIDEBAR-TOUCH-06: in alto solo il titolo, i comandi nella fila in fondo", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "SIDETOUCH-01" });
    await openSidebarOnPhone(page);

    const albero = (await page.locator(`${SIDEBAR} [data-testid="sidebar-topic-list"]`).boundingBox())!;
    const titolo = (await page.getByTestId("sidebar-topics-menu").boundingBox())!;
    const colonna = (await page.locator(SIDEBAR).boundingBox())!;

    // In cima ci sono DUE comandi, e si nominano invece di contarli: il menu
    // «Topics» a sinistra e la campanella a destra. Erano uno solo fino al
    // 12/08 («da un lato topics, cliccabile; dall'altro nient'altro»); il 14/08
    // la forma si è allargata e la campanella è salita lì — è la stessa cosa
    // che misura MOBILE-CHROME-01. Cerca e «+» restano giù, nella fila in fondo:
    // quello è il pezzo che questo test difende, e non è cambiato.
    const testata = page.locator(`${SIDEBAR} .app-drag-region`).first();
    await expect(testata.getByTestId("sidebar-topics-menu")).toHaveCount(1);
    await expect(testata.locator("button")).toHaveCount(2);
    expect(titolo.y, "il titolo deve stare sopra l'albero").toBeLessThan(albero.y);
    expect(Math.round(titolo.x - colonna.x), "il titolo non parte dal rientro della colonna").toBe(6);
    expect(Math.round(titolo.height), `il titolo è alto ${titolo.height}px: sotto la soglia del dito`).toBeGreaterThanOrEqual(44);

    // Niente barra di stato, niente riga identità: sono nel menu.
    await expect(page.locator(`${SIDEBAR} [data-testid="sidebar-status-bar"]`)).toHaveCount(0);
    await expect(page.locator(`${SIDEBAR} [data-testid="device-identity"]`)).toHaveCount(0);

    // I comandi stanno in fondo allo SCHERMO, sotto l'albero. Erano tre il
    // 12/08 (cerca · aggiungi · board); dal 14/08 sono QUATTRO — la quarta è il
    // profilo, che ha portato via l'account dal menu «Topics». Il numero si
    // aggiorna insieme ai nomi, non da solo: contare e basta lascerebbe passare
    // una porta sostituita da un'altra.
    const fila = page.locator('[data-testid="mobile-chrome-bar"]');
    await expect(fila.locator("button")).toHaveCount(4);
    const cerca = (await fila.locator('[data-testid="mobile-chrome-search"]').boundingBox())!;
    const piu = (await fila.locator('[data-testid="pane-add-menu-trigger"]').boundingBox())!;
    const board = (await fila.locator('[data-testid="mobile-chrome-board"]').boundingBox())!;
    const profilo = (await fila.locator('[data-testid="mobile-chrome-profile"]').boundingBox())!;

    for (const [nome, b] of [["il cerca", cerca], ["l'aggiungi", piu], ["la board", board], ["il profilo", profilo]] as const) {
      expect(b.y, `${nome} deve stare sotto l'albero, in fondo allo schermo`).toBeGreaterThan(albero.y);
      expect(Math.round(b.height), `${nome} è alto ${b.height}px: sotto la soglia del dito`).toBeGreaterThanOrEqual(44);
      expect(Math.round(b.width), `${nome} è largo ${b.width}px: sotto la soglia del dito`).toBeGreaterThanOrEqual(44);
    }
    // L'ordine della fila: cerca · aggiungi · board · profilo.
    expect(cerca.x).toBeLessThan(piu.x);
    expect(piu.x).toBeLessThan(board.x);
    expect(board.x).toBeLessThan(profilo.x);
  });

  /**
   * IL RIORDINO COL DITO — il gesto che su iOS non esisteva affatto.
   *
   * Il drag and drop di HTML5 non viene MAI emesso da un tocco su Safari, quindi
   * la griglia dei Fissati era, sul telefono, inerte per costruzione: nessun
   * modo di spostare una tessera. `useTouchDrag` la rimpiazza con «tieni premuto
   * e trascina» (vedi il blocco in cima all'hook).
   *
   * Qui si prova il RISULTATO — l'ordine delle tessere cambia — e la cosa che
   * lo rende usabile: il FANTASMA che segue il dito. Senza, la tessera di
   * partenza si smorza e basta, e non si capisce cosa si stia muovendo: è
   * metà del «non sta funzionando come desktop, va male» (Attilio, 07/08).
   */
  test("SIDEBAR-TOUCH-07: tenendo premuto si solleva una tessera, e trascinandola la si riordina", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "SIDETOUCH-01" });
    const a = await createTopic(request, `E2E-Drag-A-${Date.now()}`);
    const b = await createTopic(request, `E2E-Drag-B-${Date.now()}`);
    await request.put(`${BASE}/api/ui-state/sidebar-state`, {
      data: { viewMode: "timeline", showArchived: false, expandedNodes: [], pinnedItems: [a.id, b.id], pinnedLayout: [] },
    });

    await openSidebarOnPhone(page);
    // Dentro la SEZIONE, non nella pagina: il fantasma che segue il dito è una
    // `PinnedTile` vera (è il punto — deve essere identica), quindi porta lo
    // stesso testid, e portalato su `document.body` finirebbe nel conteggio.
    // Il conteggio è ciò su cui questo test decide: va preso dalla griglia.
    const tessere = page.getByTestId("sidebar-pinned-section").getByTestId("pinned-tile");
    await expect(tessere).toHaveCount(2, { timeout: 15_000 });
    await attendiTessereFerme(page);
    const nomiPrima = await tessere.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));

    const prima = (await tessere.first().boundingBox())!;
    const seconda = (await tessere.nth(1).boundingBox())!;

    // Il fantasma nasce SOLO al sollevamento, e nel mezzo del gesto.
    const fantasma = page.getByTestId("pinned-touch-ghost");
    await expect(fantasma, "a riposo non c'è nessun fantasma").toHaveCount(0);

    // Si trascina la prima oltre il centro della seconda: è la condizione che
    // `insertIndexAt` conta per decidere il posto.
    const dx = Math.round(seconda.x + seconda.width * 0.75 - (prima.x + prima.width / 2));
    await longPressDrag(page, '[data-testid="pinned-tile"]', dx, 0);

    await expect
      .poll(async () => tessere.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label"))), {
        message: "il trascinamento col dito non ha riordinato le tessere",
        timeout: 10_000,
      })
      .toEqual([nomiPrima[1], nomiPrima[0]]);

    // E a gesto finito il fantasma se n'è andato con lui.
    await expect(fantasma, "il fantasma è sopravvissuto al rilascio").toHaveCount(0);

    await request.put(`${BASE}/api/ui-state/sidebar-state`, {
      data: { viewMode: "timeline", showArchived: false, expandedNodes: [], pinnedItems: [], pinnedLayout: [] },
    }).catch(() => {});
    await deleteTopic(request, a.id).catch(() => {});
    await deleteTopic(request, b.id).catch(() => {});
  });
});
