import { test, expect, type Page, type Locator } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

const BASE = E2E_BASE;

/**
 * Le tre attese di questo file, come CONDIZIONI invece che come dormite.
 *
 * Il primo test lo diceva già nel suo commento — «POLL, don't sleep-then-sample»:
 * il `waitForTimeout(2000)` da cui partiva falliva 3 run su 4 a macchina calda,
 * perché l'ancoraggio iniziale di Virtuoso arriva quando la lista finisce di
 * misurarsi, che non è sull'orologio di nessuno. Gli altri tre test erano rimasti
 * indietro con 15,5 secondi di sonno fisso fra tutti, sbagliato in entrambe le
 * direzioni: sprecato quando lo scroll si assesta in 50ms, insufficiente quando
 * la macchina è carica — e in quel caso il test accusa lo scroll di un difetto
 * che non ha.
 *
 * Restano attese fisse SOLO dove si osserva che qualcosa NON accade: per un
 * evento che non deve arrivare non esiste condizione da pollare, serve una
 * finestra. Sono segnate una per una.
 */
const AT_BOTTOM_TOLERANCE_PX = 150; // = AT_BOTTOM_TOLERANCE_PX in scrollAuthority.ts
// Il fondo VERO non è più una TOLLERANZA: si misura (vedi `isAtTrueBottom`).
// La storia per cui conta: con 60px il test passava mentre l'umano vedeva ancora
// dello scroll sotto la freccia «torna in fondo» — la misura era più generosa
// dell'occhio, ed è per questo che il difetto è arrivato in produzione con la
// sua suite verde. Stringerla a 2px però la rendeva IRRAGGIUNGIBILE su una lista
// virtualizzata, dove `scrollHeight` include la stima delle righe non montate:
// rosso su una chat perfettamente in fondo. Chiedere il massimo al browser
// risolve entrambi i lati.

type Scroller = Locator;

const isAtBottom = (scroller: Scroller, tolerance = AT_BOTTOM_TOLERANCE_PX) =>
  scroller.evaluate(
    (el, tol) => Math.abs(el.scrollTop + el.clientHeight - el.scrollHeight) < tol,
    tolerance,
  );

/**
 * «Non c'è più scroll sotto».
 *
 * Due trappole, entrambe pagate misurando:
 *
 * 1. La tolleranza. A 150px il difetto vero passava inosservato (l'umano vedeva
 *    ancora scorrere sotto la freccia «torna in fondo»); a 2px invece il test
 *    diventa rosso su una chat perfettamente in fondo, perché su una lista
 *    virtualizzata `scrollHeight` include la STIMA delle righe non montate e
 *    balla di qualche pixel mentre le misura. Otto pixel: sotto la soglia
 *    dell'occhio, sopra il ballo della stima. Misurato: lo scarto osservato è 6.
 *
 * 2. Il metodo. La prima versione chiedeva il massimo al browser assegnando
 *    `scrollTop = scrollHeight` e poi rimettendo il valore di prima: preciso,
 *    ma MUTA la cosa che sta misurando — due eventi di scroll a ogni lettura,
 *    che fanno rimisurare la lista e cambiare il numero letto un istante dopo.
 *    In traccia si vedeva l'altezza oscillare fra due valori a ogni campione.
 *    Una misura non deve toccare il misurato.
 */
const TRUE_BOTTOM_PX = 8;
const isAtTrueBottom = (scroller: Scroller) =>
  scroller.evaluate(
    (el, tol) => el.scrollHeight - el.scrollTop - el.clientHeight <= tol,
    TRUE_BOTTOM_PX,
  );

/** Attende che la lista virtualizzata abbia finito di misurarsi e sia ancorata in fondo. */
async function settleAtBottom(scroller: Scroller): Promise<void> {
  await expect.poll(() => isAtBottom(scroller), { timeout: 15_000 }).toBe(true);
}

/**
 * PRECONDIZIONE, non decorazione: «c'è davvero qualcosa da scorrere».
 *
 * Tre test qui sotto sono cascati con messaggi opachi — «il gesto non ha
 * portato la vista lontano dal fondo», «la freccia non compare» — mentre lo
 * scroll funzionava benissimo: era il transcript che, compattato il layout,
 * non superava più la finestra di 150px. Un test che misura uno scroll deve
 * dire a voce alta se lo scroll non è nemmeno possibile, altrimenti accusa il
 * codice di un difetto che non ha.
 */
async function assertScrollabile(scroller: Scroller): Promise<void> {
  const eccedenza = await scroller.evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(
    eccedenza,
    `il transcript deve eccedere la finestra di piu' della tolleranza (${AT_BOTTOM_TOLERANCE_PX}px), ` +
      `altrimenti non c'e' scroll da osservare: semina piu' messaggi`,
  ).toBeGreaterThan(AT_BOTTOM_TOLERANCE_PX * 2);
}

/** Legge `scrollTop` finché due letture consecutive coincidono: lo scroll si è fermato. */
async function stableScrollTop(scroller: Scroller): Promise<number> {
  let last = await scroller.evaluate((el) => el.scrollTop);
  for (let i = 0; i < 40; i++) {
    const now = await scroller.evaluate((el) => el.scrollTop);
    if (now === last) return now;
    last = now;
  }
  return last;
}

/**
 * Porta lo scroller in cima con una ROTELLINA vera, e restituisce dove si è
 * fermato.
 *
 * Prima premeva `Home`, e quel tasto qui non fa quasi niente: lo scroller di
 * Virtuoso è un `div` senza `tabindex`, quindi il `click()` non gli dà il fuoco
 * e il tasto va altrove. Misurato in traccia: la lista si spostava di ~174px e
 * si fermava, mentre il test credeva di essere in cima — da lì i rossi a
 * intermittenza, che accusavano l'app di non rispettare uno scroll-up che non
 * era mai avvenuto per davvero.
 *
 * La rotellina non ha bisogno del fuoco, è esattamente il gesto che fa l'umano,
 * ed è anche la sorgente che l'autorità dello scroll riconosce come intento
 * (vedi `user-scrolled-up` / `source: 'gesture'` in scrollAuthority.ts). Si
 * ripete finché `scrollTop` smette di scendere: la lista è virtualizzata e
 * monta le righe mancanti man mano, quindi ogni colpo atterra su un'altezza che
 * un istante dopo cambia.
 */
async function scrollToTop(page: Page, scroller: Scroller): Promise<number> {
  let previous = Number.POSITIVE_INFINITY;
  // Due giri fermi, non uno: il primo può esserlo perché fra un colpo e l'altro
  // la lista ha rimisurato (monta le righe che le mancano) e il colpo è caduto
  // mentre l'altezza cambiava. Mollare lì restituiva una posizione a metà, e il
  // test accusava l'app di non aver rispettato uno scroll che non era finito.
  let fermi = 0;
  for (let attempt = 0; attempt < 12; attempt++) {
    // Si ri-punta a ogni giro: il composer cambia altezza e la pane si sposta
    // sotto il cursore, e una rotellina fuori bersaglio non scorre niente.
    await scroller.hover();
    await page.mouse.wheel(0, -2000);
    const settled = await stableScrollTop(scroller);
    if (settled === 0) return 0;
    if (settled >= previous) {
      if (++fermi >= 2) return settled;
    } else {
      fermi = 0;
      previous = settled;
    }
  }
  return previous;
}

test.describe("Chat scroll behavior", () => {
  let topicId: string;
  let topicName: string;

  test.beforeAll(async ({ request }) => {
    topicName = `scroll-test-${Date.now()}`;
    const topic = await createTopic(request, topicName);
    topicId = topic.id;

    // Seed with enough messages to make the chat scrollable.
    //
    // Erano venti, e sono diventati pochi: la chat si è COMPATTATA (la riga
    // dell'orario non occupa più il suo spazio da invisibile, e le corse di
    // tool sono un item solo), quindi venti messaggi corti stanno quasi dentro
    // la finestra. Con `scrollHeight - clientHeight` sceso sotto i 150px di
    // tolleranza, tre test qui sotto cadevano — non per un difetto dello
    // scroll, ma perché non c'era più abbastanza da scorrere. Quaranta danno
    // margine, e `assertScrollabile` sotto lo verifica invece di darlo per
    // scontato: la prossima volta che la densità cambia, il rosso lo dirà.
    for (let i = 0; i < 40; i++) {
      await request.post(`${BASE}/api/topics/${topicId}/system-message`, {
        data: { content: `Seed message ${i + 1}: ${"Lorem ipsum dolor sit amet. ".repeat(3)}` },
        ignoreHTTPSErrors: true,
      });
    }
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });

  // Lo scroller virtualizzato viene preso con `.first()`: con le pane dei file
  // precedenti ancora aperte (pane-store unico per la suite seriale) il primo
  // scroller può essere quello di UN'ALTRA chat. Reset al topic seminato qui.
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  test("auto-scrolls to bottom when new message arrives and user is at bottom", async ({ page, request }) => {
    await goToApp(page);
    await openTopic(page, new RegExp(topicName));

    const scroller = page.locator('[data-testid="virtuoso-scroller"], [data-virtuoso-scroller]').first();
    await scroller.waitFor({ state: "visible", timeout: 15000 });

    // 150px tolerance matches the app's own at-bottom threshold
    // (AT_BOTTOM_TOLERANCE_PX in client/src/components/Chat/scrollAuthority.ts);
    // the redesign lands ~1 short message short of a tight 60px window.
    const atBottom = () =>
      scroller.evaluate((el) => Math.abs(el.scrollTop + el.clientHeight - el.scrollHeight) < 150);

    // POLL, don't sleep-then-sample. This assertion used to run once after a
    // fixed waitForTimeout(2000) and failed 3 runs out of 4 on a warm machine:
    // Virtuoso's initial bottom-anchor lands whenever the list finishes
    // measuring, which is not on anybody's clock. Same reason the second
    // assertion polls instead of sleeping — auto-scroll is a race with the
    // WS frame, and the fixed wait was betting on it.
    await expect.poll(atBottom, { timeout: 15000 }).toBe(true);

    await request.post(`${BASE}/api/topics/${topicId}/system-message`, {
      data: { content: `New message at ${Date.now()}` },
      ignoreHTTPSErrors: true,
    });

    // The list must END UP at the bottom; it may leave it for a frame while the
    // new row is measured. Polling asserts the settled state, which is the
    // behaviour under test.
    await expect.poll(atBottom, { timeout: 15000 }).toBe(true);
  });

  test("does NOT auto-scroll when user has scrolled up", async ({ page, request }) => {
    await goToApp(page);
    await openTopic(page, new RegExp(topicName));

    const scroller = page.locator('[data-testid="virtuoso-scroller"], [data-virtuoso-scroller]').first();
    // Lo scroller e' la PRECONDIZIONE della cosa in esame, non una comodita'
    // dell'ambiente: se sparisce, e' il difetto — non un motivo per saltare. Con
    // `test.skip(count === 0)` questi tre test diventavano verdi-vuoti proprio
    // nel caso che dovevano intercettare, e il conteggio dei "saltati" non lo
    // guarda nessuno. Asserire lo fa cadere con il messaggio giusto.
    await expect(scroller, 'la chat deve montare lo scroller virtualizzato').toHaveCount(1, { timeout: 10_000 });
    await settleAtBottom(scroller);
    await assertScrollabile(scroller);

    const scrollBefore = await scrollToTop(page, scroller);

    // Add a new message
    await request.post(`${BASE}/api/topics/${topicId}/system-message`, {
      data: { content: `Message while scrolled up ${Date.now()}` },
      ignoreHTTPSErrors: true,
    });

    // ATTESA FISSA VOLUTA: qui si osserva che una cosa NON accade (la lista non
    // deve rincorrere il messaggio nuovo). Per un evento che non deve arrivare
    // non c'e' condizione da pollare — serve una finestra in cui, se lo scroll
    // saltasse, lo si vedrebbe. Due secondi coprono il round-trip WS piu' il
    // rendering della riga.
    await page.waitForTimeout(2000);

    // La domanda è «la vista è SALTATA IN FONDO?», non «scrollTop è identico».
    // Con una lista virtualizzata il secondo non è un modo di misurare il primo:
    // fermi in cima, Virtuoso monta le righe che stanno sopra e AGGIUSTA
    // `scrollTop` di centinaia di pixel per non farti spostare visivamente —
    // roba sua, che non ha niente a che vedere con un auto-scroll. Misurato in
    // traccia: l'autorità resta sganciata e nessun pin parte, eppure il vecchio
    // confronto falliva. Si asserisce la cosa vera: sei rimasto lontano dal
    // fondo.
    // La costante vive nel processo del test, non nella pagina: va passata
    // dentro `evaluate`, altrimenti è `undefined` là dove viene valutata.
    const massimoLontano = await scroller.evaluate(
      (el, tol) => el.scrollHeight - el.clientHeight - tol,
      AT_BOTTOM_TOLERANCE_PX,
    );
    expect(scrollBefore, "il gesto deve aver portato la vista lontano dal fondo").toBeLessThan(massimoLontano);
    expect(await isAtBottom(scroller), "un messaggio in arrivo NON deve riportare in fondo").toBe(false);
  });

  test("dopo un refresh la chat riapre IN FONDO, non a metà né in cima", async ({ page }) => {
    // «Quando refresho si perde»: ricaricare è il gesto più comune che ci sia, e
    // una chat che riapre in cima ti fa scorrere a mano fino all'ultimo
    // messaggio ogni volta. Il fondo è lo stato di riposo della chat.
    await goToApp(page);
    await openTopic(page, new RegExp(topicName));

    const scroller = page.locator('[data-testid="virtuoso-scroller"], [data-virtuoso-scroller]').first();
    await expect(scroller, 'la chat deve montare lo scroller virtualizzato').toHaveCount(1, { timeout: 10_000 });
    await settleAtBottom(scroller);

    await page.reload();
    const dopo = page.locator('[data-testid="virtuoso-scroller"], [data-virtuoso-scroller]').first();
    await expect(dopo).toHaveCount(1, { timeout: 15_000 });

    // Il fondo va raggiunto DA SOLO: nessuno scroll, nessun click.
    await expect.poll(() => isAtTrueBottom(dopo), { timeout: 12_000 }).toBe(true);

    // E ci resta: due letture a distanza, per escludere il rimbalzo. Il
    // messaggio d'errore porta i numeri: un booleano non dice mai di quanto.
    await page.waitForTimeout(1200);
    const stato = await dopo.evaluate((el) => {
      const prima = el.scrollTop;
      el.scrollTop = el.scrollHeight;
      const massimo = el.scrollTop;
      el.scrollTop = prima;
      return { prima: Math.round(prima), massimo: Math.round(massimo), h: el.scrollHeight, c: el.clientHeight };
    });
    expect(stato.prima, `posizione ${JSON.stringify(stato)}`).toBeGreaterThanOrEqual(stato.massimo - 1);
  });

  /**
   * Lo stesso refresh, ma con l'ULTIMO messaggio più alto della finestra: è il
   * caso vero (una risposta lunga, un turno pieno di blocchi tool) ed è quello
   * che il test qui sopra non poteva vedere.
   *
   * Con `initialTopMostItemIndex` passato come solo indice, Virtuoso allinea
   * l'INIZIO di quell'item in cima alla viewport: coi messaggi corti l'item ci
   * sta tutto e il risultato È il fondo, quindi tutto verde; con un messaggio
   * alto ti lascia in cima a quel messaggio e il resto lo devi riscrollare a
   * mano. Sintomo riportato: «aggiorno mentre sono agganciato sotto allo stream
   * e mi porta sopra».
   */
  test("il refresh resta in fondo anche se l'ultimo messaggio è più alto della finestra", async ({ page, request }) => {
    // Topic PROPRIO, non quello condiviso del file: un muro di 1275px in coda
    // cambia la geometria di tutti i test che vengono dopo, e li faceva cadere a
    // intermittenza — un test non deve lasciare in eredità il proprio scenario.
    const soloName = `scroll-tall-${Date.now()}`;
    const solo = await createTopic(request, soloName);
    try {
      for (let i = 0; i < 6; i++) {
        await request.post(`${BASE}/api/topics/${solo.id}/system-message`, {
          data: { content: `Seed ${i + 1}: ${"Lorem ipsum dolor sit amet. ".repeat(3)}` },
          ignoreHTTPSErrors: true,
        });
      }
      // Prosa lunga, non 120 righe con "\n": il messaggio di sistema le collassa
      // e l'item resta più BASSO della viewport — cioè il test non proverebbe
      // niente (misurato: 469px contro 760 di finestra). Così invece sono 1275px.
      await request.post(`${BASE}/api/topics/${solo.id}/system-message`, {
        data: { content: "Lorem ipsum dolor sit amet consectetur adipiscing elit. ".repeat(180) },
        ignoreHTTPSErrors: true,
      });
      await resetPaneStore(request, [solo.id]);

      await goToApp(page);
      await openTopic(page, new RegExp(soloName));

      const scroller = page.locator('[data-testid="virtuoso-scroller"], [data-virtuoso-scroller]').first();
      await expect(scroller, 'la chat deve montare lo scroller virtualizzato').toHaveCount(1, { timeout: 10_000 });
      await settleAtBottom(scroller);
      // Precondizione: l'ultimo messaggio deve DAVVERO superare la finestra,
      // altrimenti questo test tornerebbe a essere quello di sopra travestito.
      const supera = await scroller.evaluate((el) => {
        const rows = el.querySelectorAll('[data-item-index]');
        const last = rows[rows.length - 1] as HTMLElement | undefined;
        return last ? last.getBoundingClientRect().height > el.clientHeight : false;
      });
      expect(supera, "il messaggio di prova deve essere più alto della viewport").toBe(true);

      await page.reload();
      const dopo = page.locator('[data-testid="virtuoso-scroller"], [data-virtuoso-scroller]').first();
      await expect(dopo).toHaveCount(1, { timeout: 15_000 });

      await expect.poll(() => isAtTrueBottom(dopo), { timeout: 12_000 }).toBe(true);
      await page.waitForTimeout(1200);
      expect(await isAtTrueBottom(dopo)).toBe(true);
    } finally {
      await deleteTopic(request, solo.id);
    }
  });

  test("scroll-to-bottom button appears when scrolled up and works on click", async ({ page }) => {
    await goToApp(page);
    await openTopic(page, new RegExp(topicName));

    const scroller = page.locator('[data-testid="virtuoso-scroller"], [data-virtuoso-scroller]').first();
    // Lo scroller e' la PRECONDIZIONE della cosa in esame, non una comodita'
    // dell'ambiente: se sparisce, e' il difetto — non un motivo per saltare. Con
    // `test.skip(count === 0)` questi tre test diventavano verdi-vuoti proprio
    // nel caso che dovevano intercettare, e il conteggio dei "saltati" non lo
    // guarda nessuno. Asserire lo fa cadere con il messaggio giusto.
    await expect(scroller, 'la chat deve montare lo scroller virtualizzato').toHaveCount(1, { timeout: 10_000 });
    await settleAtBottom(scroller);
    await assertScrollabile(scroller);

    const scrollBtn = page.getByRole("button", { name: "Scroll to bottom" });

    // Home fa uno scroll nativo, che e' cio' che l'IntersectionObserver di
    // Virtuoso rileva per far comparire il bottone.
    await scrollToTop(page, scroller);
    await expect(scrollBtn).toBeVisible({ timeout: 8000 });

    await scrollBtn.click();

    // Lo scroll e' animato (400ms smooth + 600ms di guardia): si polla il fondo
    // vero invece di indovinare quando l'animazione e' finita.
    await expect
      .poll(() => isAtTrueBottom(scroller), { timeout: 10_000 })
      .toBe(true);

    // Button should disappear
    await expect(scrollBtn).not.toBeVisible({ timeout: 5000 });
  });

  test("scroll-to-bottom button reaches true bottom and stays there", async ({ page }) => {
    await goToApp(page);
    await openTopic(page, new RegExp(topicName));

    const scroller = page.locator('[data-testid="virtuoso-scroller"], [data-virtuoso-scroller]').first();
    // Lo scroller e' la PRECONDIZIONE della cosa in esame, non una comodita'
    // dell'ambiente: se sparisce, e' il difetto — non un motivo per saltare. Con
    // `test.skip(count === 0)` questi tre test diventavano verdi-vuoti proprio
    // nel caso che dovevano intercettare, e il conteggio dei "saltati" non lo
    // guarda nessuno. Asserire lo fa cadere con il messaggio giusto.
    await expect(scroller, 'la chat deve montare lo scroller virtualizzato').toHaveCount(1, { timeout: 10_000 });
    await settleAtBottom(scroller);
    await assertScrollabile(scroller);

    const scrollBtn = page.getByRole("button", { name: "Scroll to bottom" });

    await scrollToTop(page, scroller);
    await expect(scrollBtn).toBeVisible({ timeout: 8000 });

    await scrollBtn.click();

    // Prima si aspetta che l'animazione ARRIVI in fondo (condizione), poi si
    // guarda se ci RESTA (finestra).
    await expect
      .poll(() => isAtTrueBottom(scroller), { timeout: 10_000 })
      .toBe(true);

    // ATTESA FISSA VOLUTA: il difetto in esame e' il RIMBALZO — la lista che
    // torna in fondo e poi se ne stacca da sola. Un rimbalzo si vede solo
    // guardando per un po', quindi qui il campionamento a tempo E' la misura, non
    // un'attesa che si possa sostituire con una condizione. Quattro letture in
    // due secondi.
    const measurements: boolean[] = [];
    for (let i = 0; i < 4; i++) {
      await page.waitForTimeout(500);
      measurements.push(await isAtTrueBottom(scroller));
    }

    // ALL measurements should report at-bottom (no drift/bounce)
    expect(measurements.every(m => m)).toBe(true);

    // Scroll-to-bottom button should remain hidden (no re-appearance from bounce)
    await expect(scrollBtn).not.toBeVisible({ timeout: 2000 });
  });
});
