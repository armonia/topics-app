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
 */
import { test, expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const BASE = E2E_BASE;
const SIDEBAR = '[role="navigation"][aria-label="Topics sidebar"]';
/** Il testo che il seed manda: deve ricomparire sotto al nome della riga. */
const LAST_MESSAGE = "Questa frase deve comparire sotto al nome nella sidebar.";

/** Luminanza relativa WCAG di un `rgb(...)` computato. */
function luminance(css: string): number {
  const m = css.match(/\d+(\.\d+)?/g);
  if (!m || m.length < 3) throw new Error(`colore non parsabile: ${css}`);
  const [r, g, b] = m.slice(0, 3).map((v) => {
    const c = Number(v) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

async function bg(page: Page, selector: string): Promise<string> {
  return page.locator(selector).first().evaluate((el) => getComputedStyle(el).backgroundColor);
}

/**
 * Su mobile la sidebar NASCE CHIUSA (`useSidebarAndLayout`: `isDetached ||
 * isMobile ? true : …`), quindi l'helper condiviso `goToApp` — che aspetta la
 * colonna VISIBILE — non serve qui: andrebbe in timeout su una sidebar che c'è
 * ma è tradotta fuori schermo. Si apre come la aprirebbe un dito, toccando il
 * bottone del pannello. L'auto-collapse è agganciato al CAMBIO di `isMobile`,
 * non allo stato, quindi una volta aperta resta aperta.
 */
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
  await page.keyboard.press("ControlOrMeta+b");
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
   * IL CHROME È UNA SUPERFICIE SOLA.
   *
   * Il difetto che ha aperto tutto questo: su iPhone la fascia in cima cambiava
   * colore aprendo e chiudendo la sidebar (`--bg-surface` contro `--bg`), e i
   * due estremi della stessa colonna avevano due token diversi — sopra
   * `bg-surface`, sotto `bg-app-bg`. Qui si pretende che header, albero e barra
   * di stato dipingano lo STESSO pixel, e che quel pixel sia un gradino SOTTO la
   * pagina, non sopra: è ciò che salda la colonna alla barra di stato opaca che
   * iOS disegna sopra la PWA.
   */
  test("SIDEBAR-CHROME-01: la colonna è una superficie sola, e sta sotto la pagina", async ({ page }) => {
    await openSidebarOnPhone(page);

    const chrome = await bg(page, SIDEBAR);
    // La barra di stato in fondo NON deve dipingere: deve ereditare la colonna.
    // Un suo sfondo proprio è ciò che sotto Tauri comporrebbe una SECONDA mano
    // dell'alpha della vibrancy sopra la prima (0.80 contro 0.55).
    const statusBg = await bg(page, `${SIDEBAR} [data-testid="sidebar-status-bar"]`);
    expect(
      ["rgba(0, 0, 0, 0)", "transparent", chrome],
      `la fascia di stato dipinge ${statusBg}, la colonna ${chrome}`,
    ).toContain(statusBg);

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

    const page_ = await bg(page, ".content-flip-layer");
    const lChrome = luminance(chrome);
    const lPage = luminance(page_);
    expect(
      lChrome,
      `chrome ${chrome} (L=${lChrome.toFixed(4)}) deve stare SOTTO la pagina ${page_} (L=${lPage.toFixed(4)})`,
    ).toBeLessThan(lPage);
  });

  /**
   * UN RITMO SOLO. Prima la riga chat era 40px e ogni altra 44, e utility e
   * board restavano 32 anche su iPhone — sotto il minimo di tap target e 12px
   * più basse delle vicine. Qui si pretende che ogni riga dell'albero abbia la
   * STESSA altezza e lo STESSO bordo sinistro: il ritmo verticale non salta a
   * ogni cambio di tipo, e la colonna del testo è una.
   */
  test("SIDEBAR-CHROME-02: tutte le righe hanno la stessa altezza (44) e lo stesso bordo sinistro", async ({ page }) => {
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
    await openSidebarOnPhone(page);
    const row = page.getByRole("treeitem", { name: topicName });
    await expect(row).toBeVisible({ timeout: 10_000 });

    await longPress(page, `[role="treeitem"][aria-label="${topicName}"]`);
    await expect(page.getByText("Rinomina", { exact: true })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Copia link", { exact: true })).toBeVisible();
  });

  /**
   * IL «…» APRE LO STESSO MENU. Il bottone resta perché un gesto nascosto non si
   * scopre, ma non deve essere una seconda strada con meno voci: le due porte
   * danno sulla stessa stanza.
   */
  test("SIDEBAR-TOUCH-02: il «…» apre lo stesso menu del gesto", async ({ page }) => {
    await openSidebarOnPhone(page);
    const row = page.getByRole("treeitem", { name: topicName });
    await expect(row).toBeVisible({ timeout: 10_000 });

    await row.getByRole("button", { name: `Azioni per ${topicName}` }).tap();
    await expect(page.getByText("Rinomina", { exact: true })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Copia link", { exact: true })).toBeVisible();
  });

  /**
   * I BERSAGLI NON SI MANGIANO A VICENDA. `.tap-expand` proietta 44×44 attorno a
   * un glifo da 24: nel binario in coda alla riga due aree così, con i centri a
   * 32px, si sovrappongono di 12 e vince l'ultimo nel DOM — il bordo del «…»
   * attivava il vicino. La correzione è `.tap-expand-y` (cresce solo in altezza)
   * più un box reale più grande. Qui si misura il punto centrale di ogni
   * bersaglio del binario e si pretende che colpisca SE STESSO.
   */
  test("SIDEBAR-TOUCH-03: ogni bersaglio del binario colpisce sé stesso", async ({ page }) => {
    await openSidebarOnPhone(page);
    const row = page.getByRole("treeitem", { name: topicName });
    await expect(row).toBeVisible({ timeout: 10_000 });

    const verdict = await row.evaluate((rowEl) => {
      const targets = [...rowEl.querySelectorAll("button")];
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
      });
    });

    expect(verdict.length, "nessun bottone nel binario: il test sarebbe verde per vuoto").toBeGreaterThan(0);
    const stolen = verdict.filter((v) => !v.ownsItsCentre);
    expect(stolen, `bersagli il cui centro è rubato da un altro: ${JSON.stringify(verdict)}`).toEqual([]);
    // Il bottone dei tre puntini è l'unica porta touch verso tutti i comandi
    // della riga: su schermo stretto deve essere un box vero, non 24px.
    const menu = verdict.find((v) => v.label.startsWith("Azioni per"));
    expect(menu, `«Azioni per» non trovato fra ${JSON.stringify(verdict)}`).toBeTruthy();
    expect(menu!.w, `il «…» è largo ${menu!.w}px`).toBeGreaterThanOrEqual(36);
  });
});
