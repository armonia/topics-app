/**
 * E2E — «MOVIMENTO RIDOTTO» NON SPOSTA I COMANDI DEL CHROME, E L'ANGOLO DELLA
 * BARRA RESTA UN POSTO NEUTRO DOVE CLICCARE.
 *
 * L'08/08 `reopen-closed-tab` andò in timeout di 30s appena la config accese
 * `reducedMotion: "reduce"`: il click sul punto (5, 5) del tab bar non arrivava
 * mai perché un `raised-control-overlay` — il comando che riapre la colonna, in
 * testa alla riga — lo intercettava. Il sospetto scritto allora era una
 * transizione: un controllo la cui posizione dipende da un `transform` che
 * sotto `prefers-reduced-motion` non avviene mai, cioè un pezzo di interfaccia
 * che si sposta solo per chi ha chiesto meno animazioni.
 *
 * Rimisurato: il sospetto era sbagliato e la causa è più banale e più cattiva.
 * Il comando stava a `md:left-[5.5px]` (introdotto lo stesso 08/08, cbd00427) —
 * un MEZZO PIXEL. Il punto del click cade a `bar.x + 5`, il bordo sinistro del
 * comando a `bar.x + 5.5`: mezzo pixel di distanza, che l'hit-test di Chromium
 * arrotonda DENTRO la scatola. Misurato qui forzando l'inset:
 *
 *   left 5.5px → elementFromPoint(bar.x+5) = il comando   → click in timeout
 *   left 6px   → elementFromPoint(bar.x+5) = la barra     → click OK
 *
 * …e vale IDENTICO nelle due modalità: il movimento ridotto non c'entrava, era
 * una correlazione (il mezzo pixel visse un giorno solo, il 08/08, ed è sparito
 * il 09/08 con ab8d7514 che ha portato l'inset a 6). Restava però vera la
 * ragione per cui il difetto meritava un test: un comando incollato al bordo si
 * mangia i click che passano di lì, e mezzo pixel di margine non è una
 * posizione, è un lancio di moneta che cambia con lo zoom, il DPR e la
 * larghezza della colonna.
 *
 * Questa spec blocca le due cose insieme, e le blocca MISURANDO. L'ordine non è
 * decorativo — è quello che rende utile il rosso:
 *  1. PER OGNI MODALITÀ, DA SOLA (nessun confronto fra le due): i bordi dei
 *     comandi cadono su pixel interi, all'incasso della riga (6px), e il punto
 *     che il gesto prende di mira dista almeno un pixel INTERO dal bordo del
 *     comando in testa. È qui che il mezzo pixel muore, e muore su un numero;
 *  2. `elementFromPoint` su quel punto risponde la barra e non un comando;
 *  3. solo dopo, il click NON forzato — il gesto per intero, che è ciò che andò
 *     in timeout;
 *  4. infine il confronto FRA le due modalità: nessuna regola di accessibilità
 *     sposta un bersaglio.
 *
 * PERCHÉ L'ASSOLUTO VIENE PRIMA DEL CONFRONTO. Il difetto colpiva le due
 * modalità ALLO STESSO MODO: due misure sbagliate uguali restano uguali, e un
 * `toEqual` fra le due passa liscio. Il confronto (punto 4) sorveglia un'altra
 * cosa — che il movimento ridotto non sposti niente — e non può essere l'unica
 * rete: da solo non vedrebbe mai il mezzo pixel.
 *
 * LA LEVA DEL CONTROLLO NEGATIVO È `CHROME_ROW_ACTION_INSET_LEFT` in
 * `lib/selectionStyles.ts`, non `PaneTabBar.tsx`. Nel commit che portò questa
 * spec (c4330a25) il diff di `PaneTabBar.tsx` è di soli COMMENTI: riportarlo
 * indietro non cambia un pixel, e chi prova a falsificare la guardia di lì la
 * vede passare e conclude che non guarda niente. Per rimetterci il difetto si
 * riscrive quella costante a `'left-[1.5px] md:left-[5.5px]'` e si RICOSTRUISCE
 * il bundle dell'albero in prova (TOPICS_E2E_BUNDLE_DIR): misurato il 12/08, la
 * spec cade sull'incasso frazionario in entrambe le modalità.
 *
 * Nessun `expect.soft` qui dentro: tutto ciò che è scritto definisce il difetto,
 * e ciò che definisce il difetto deve FERMARE il test.
 *
 * I due contesti si aprono a mano (`browser.newContext`) invece di usare due
 * test con `test.use`: il confronto fra le due modalità è UN'asserzione sola e
 * deve vivere in un posto solo, senza stato condiviso fra test che un retry
 * rimonterebbe a metà.
 */
import { test, expect, type Browser, type Page, type APIRequestContext } from "@playwright/test";
import { createTopic, deleteTopic, seedPaneStore, waitForTopicVisible } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/** L'incasso di riga: `CHROME_ROW_ACTION_INSET(_LEFT)` in lib/selectionStyles. */
const ROW_INSET = 6;
/**
 * L'angolo neutro, in coordinate della barra: lo stesso punto che
 * `reopen-closed-tab` clicca per portare il fuoco fuori da un campo di testo, ed
 * è il punto che il mezzo pixel si mangiava.
 */
const PUNTO = { x: 5, y: 5 };
/** Le stesse condizioni del progetto `chromium` (playwright.config.ts). */
const VIEWPORT = { width: 1280, height: 800 };

type Rect = { x: number; y: number; width: number; height: number };
type Misura = {
  reduce: boolean;
  bar: Rect;
  chrome: Rect;
  /** I comandi sovrapposti alla strip, ordinati da sinistra. */
  comandi: { cls: string; rect: Rect }[];
  /** Chi risponde nell'angolo neutro (5, 5) del tab bar. */
  angolo: { dentroLaBarra: boolean; dentroUnComando: boolean; chi: string };
};

async function seedDueTab(
  request: APIRequestContext,
  t1: { id: string; name: string },
  t2: { id: string; name: string },
): Promise<void> {
  await seedPaneStore(request, () => ({
    panes: {
      [t1.id]: { id: t1.id, type: "chat", title: t1.name, topicId: t1.id },
      [t2.id]: { id: t2.id, type: "chat", title: t2.name, topicId: t2.id },
    },
    groups: {
      "group:default": {
        id: "group:default",
        paneIds: [t1.id, t2.id],
        splitRatio: 1,
        splitAxis: "horizontal",
      },
    },
    projects: {},
    groupOrder: ["group:default"],
    closedStack: [],
  }));
  await request.put(`${E2E_BASE}/api/ui-state/panels`, {
    data: { openPanels: [t1.id, t2.id] },
    ignoreHTTPSErrors: true,
  });
}

async function misura(page: Page, punto: { x: number; y: number }): Promise<Misura> {
  return page.evaluate((p) => {
    const r = (e: Element): { x: number; y: number; width: number; height: number } => {
      const b = e.getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    };
    const bar = document.querySelector('[data-testid="panel-tab-bar"]') as HTMLElement;
    const chrome = bar.closest(".pane-chrome-bar") as HTMLElement;
    const comandi = Array.from(document.querySelectorAll<HTMLElement>(".raised-control-overlay"))
      .filter((e) => chrome.contains(e))
      .sort((a, b) => a.getBoundingClientRect().x - b.getBoundingClientRect().x)
      .map((e) => ({ cls: e.className, rect: r(e) }));
    const b = bar.getBoundingClientRect();
    const sottoIlPunto = document.elementFromPoint(b.x + p.x, b.y + p.y);
    return {
      reduce: matchMedia("(prefers-reduced-motion: reduce)").matches,
      bar: r(bar),
      chrome: r(chrome),
      comandi,
      angolo: {
        dentroLaBarra: !!sottoIlPunto && bar.contains(sottoIlPunto),
        dentroUnComando: !!sottoIlPunto && !!sottoIlPunto.closest(".raised-control-overlay"),
        // Chi risponde, per nome: quando il punto torna coperto il rosso deve
        // dire QUALE elemento se l'è preso, non solo che non era la barra.
        chi: sottoIlPunto ? `${sottoIlPunto.tagName.toLowerCase()}.${sottoIlPunto.className}` : "(nessuno)",
      },
    };
  }, punto);
}

/**
 * LE ASSERZIONI ASSOLUTE, UNA MODALITÀ ALLA VOLTA.
 *
 * Nessuna di queste guarda l'altra modalità: è il punto: il difetto del 08/08
 * colpiva entrambe allo stesso modo, e ciò che confronta le due misure fra loro
 * non poteva vederlo. Qui si misura contro NUMERI — l'incasso della riga, il
 * pixel intero, la distanza dal punto del gesto.
 */
function verificaAssoluta(m: Misura, modo: string): void {
  expect(m.comandi.length, `[${modo}] ci deve essere almeno un comando da misurare`).toBeGreaterThan(
    0,
  );

  const primo = m.comandi[0];
  const ultimo = m.comandi[m.comandi.length - 1];

  // ── 1. UN PIXEL INTERO FRA IL GESTO E LA SCATOLA DEL COMANDO ───────────────
  // LA misura del difetto originale, scritta come numero, e per prima: quando
  // qualcosa qui si rompe questo è il messaggio che spiega COSA è successo.
  // A `left: 5.5px` il bordo del comando cade a mezzo pixel dal punto che il
  // click prende di mira e l'hit-test di Chromium arrotonda DENTRO la scatola.
  // Sotto un pixel pieno di distanza il punto non è più della barra: è di chi
  // vince l'arrotondamento.
  const margine = primo.rect.x - (m.bar.x + PUNTO.x);
  expect(
    margine,
    `[${modo}] fra il punto (${PUNTO.x},${PUNTO.y}) e il bordo del comando in testa ` +
      `ci deve essere almeno un pixel INTERO, misurato ${margine}`,
  ).toBeGreaterThanOrEqual(1);

  // ── 2. CHI RISPONDE NEL PUNTO ──────────────────────────────────────────────
  // La stessa cosa chiesta al browser invece che all'aritmetica: `margine` dice
  // dove sta il bordo, `elementFromPoint` dice chi vince davvero l'hit-test.
  expect(
    m.angolo.dentroUnComando,
    `[${modo}] (${PUNTO.x},${PUNTO.y}) non deve stare su un comando — risponde ${m.angolo.chi}`,
  ).toBe(false);
  expect(
    m.angolo.dentroLaBarra,
    `[${modo}] (${PUNTO.x},${PUNTO.y}) deve rispondere alla barra — risponde ${m.angolo.chi}`,
  ).toBe(true);

  // ── 3. BORDI SU PIXEL INTERI ───────────────────────────────────────────────
  // Più larga della precedente e per questo dopo: vale per OGNI comando della
  // riga, non solo per quello che sta sul punto del gesto. Mezzo pixel di
  // margine non è una posizione — è un lancio di moneta che cambia con lo zoom,
  // il DPR e la larghezza della colonna, e domani tocca a un altro bersaglio.
  for (const c of m.comandi) {
    expect(Number.isInteger(c.rect.x), `[${modo}] bordo sinistro intero (${c.rect.x}): ${c.cls}`).toBe(
      true,
    );
    expect(
      Number.isInteger(c.rect.x + c.rect.width),
      `[${modo}] bordo destro intero (${c.rect.x + c.rect.width}): ${c.cls}`,
    ).toBe(true);
  }

  // ── 4. INCASSO DELLA RIGA, IN TESTA E IN CODA ──────────────────────────────
  expect(primo.rect.x - m.chrome.x, `[${modo}] il comando in testa sta a ROW_INSET dal bordo`).toBe(
    ROW_INSET,
  );
  expect(
    m.chrome.x + m.chrome.width - (ultimo.rect.x + ultimo.rect.width),
    `[${modo}] il comando in coda sta a ROW_INSET dal bordo`,
  ).toBe(ROW_INSET);
}

/**
 * Apre l'app in un contesto con la modalità movimento richiesta, semina due tab,
 * ne chiude una (lo stato in cui il difetto si manifestava), misura, e prova sul
 * posto il click NON forzato sull'angolo — cioè il gesto che andò in timeout.
 *
 * Tutto dentro una funzione, e il contesto si chiude prima di aprire l'altro: i
 * due contesti parlano con LO STESSO server, quindi tenerli aperti insieme
 * significherebbe che la semina del secondo arriva in broadcast al primo e gli
 * cambia le tab sotto i piedi a metà misura.
 */
async function apriEMisura(
  browser: Browser,
  request: APIRequestContext,
  reducedMotion: "reduce" | "no-preference",
): Promise<Misura> {
  const ctx = await browser.newContext({
    baseURL: E2E_BASE,
    viewport: VIEWPORT,
    locale: "it-IT",
    reducedMotion,
  });
  const t1 = await createTopic(request, `RM-A-${Date.now()}`);
  const t2 = await createTopic(request, `RM-B-${Date.now()}`);
  try {
    const page = await ctx.newPage();
    await seedDueTab(request, t1, t2);

    await page.goto("/");
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15_000 });
    await waitForTopicVisible(page, t2.id);

    const tabBar = page.locator('[data-testid="panel-tab-bar"]');
    const tabs = tabBar.locator('[draggable="true"]');
    await expect(tabs).toHaveCount(2, { timeout: 10_000 });
    const ultima = tabs.nth(1);
    await ultima.hover();
    await ultima.locator("button").last().click({ force: true });
    await expect(tabs).toHaveCount(1, { timeout: 5_000 });

    const m = await misura(page, PUNTO);
    expect(m.reduce, `il contesto deve davvero essere in ${reducedMotion}`).toBe(
      reducedMotion === "reduce",
    );

    // PRIMA I NUMERI, POI IL GESTO. Le due cose falliscono insieme quando
    // l'incasso torna frazionario, ma dicono cose diverse: la misura nomina il
    // mezzo pixel («margine 0.5»), il click dice solo «timeout». Misurare per
    // primo significa che chi legge il rosso sa già cosa è successo.
    await test.step(`misure assolute [${reducedMotion}]`, async () => {
      verificaAssoluta(m, reducedMotion);
    });

    // LA PROVA PER INTERO: non `elementFromPoint`, ma il gesto: un click NON
    // forzato sull'angolo, come lo fa chi porta il fuoco fuori da un campo di
    // testo. Timeout corto — se l'angolo torna coperto lo si sa in 5 secondi
    // invece che in 30.
    await test.step(`click non forzato sull'angolo [${reducedMotion}]`, async () => {
      await tabBar.click({ position: PUNTO, timeout: 5_000 });
    });
    return m;
  } finally {
    await ctx.close();
    await deleteTopic(request, t1.id).catch(() => {});
    await deleteTopic(request, t2.id).catch(() => {});
  }
}

test.describe("@reduced-motion-chrome comandi del chrome sotto movimento ridotto", () => {
  test("un pixel intero fra il gesto e il comando in OGNI modalità, e nessuna delle due sposta niente", async ({
    browser,
    request,
  }) => {
    test.info().annotations.push({ type: "spec", description: "CHROME-08" });
    const normale = await apriEMisura(browser, request, "no-preference");
    const ridotto = await apriEMisura(browser, request, "reduce");

    // ── 1. LE MISURE ASSOLUTE SONO GIÀ PASSATE ───────────────────────────────
    // `apriEMisura` ha eseguito `verificaAssoluta` dentro OGNI contesto, prima
    // del click: pixel interi, incasso della riga, un pixel pieno fra il gesto e
    // il comando, e la barra che risponde nel punto. Sono quelle a fermare il
    // test quando l'incasso torna frazionario — non ciò che segue.

    // ── 2. NESSUN COMANDO SI SPOSTA ──────────────────────────────────────────
    // La riga di chrome deve essere la stessa scatola nelle due modalità,
    // altrimenti il confronto dei comandi non dice niente.
    expect(ridotto.chrome).toEqual(normale.chrome);
    expect(ridotto.comandi.length, "stesso numero di comandi sovrapposti alla strip").toBe(
      normale.comandi.length,
    );
    expect(ridotto.comandi.length).toBeGreaterThan(0);
    // `toEqual` sui rettangoli, non una tolleranza: qui NON si sta misurando
    // un'animazione a metà — in entrambi i casi il layout è fermo, e un pixel di
    // differenza vorrebbe dire che una regola di accessibilità ha spostato un
    // bersaglio.
    expect(ridotto.comandi.map((c) => c.rect)).toEqual(normale.comandi.map((c) => c.rect));

    // ── 3. LA BARRA È LA STESSA SCATOLA ──────────────────────────────────────
    // Il punto del gesto è in coordinate della BARRA: se la barra stessa si
    // spostasse fra le due modalità, «(5,5)» sarebbe due punti diversi dello
    // schermo e le due misure assolute non parlerebbero della stessa cosa.
    expect(ridotto.bar).toEqual(normale.bar);
  });
});
