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
 * Questa spec blocca le due cose insieme, e le blocca MISURANDO:
 *  1. i comandi in testa e in coda al chrome occupano lo stesso rettangolo con
 *     e senza `prefers-reduced-motion` (nessuna regola di accessibilità può
 *     spostare un bersaglio);
 *  2. i loro bordi cadono su pixel interi, all'incasso della riga (6px);
 *  3. il click NON forzato sull'angolo neutro della barra arriva, in entrambe
 *     le modalità — che è esattamente il gesto andato in timeout.
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
  angolo: { dentroLaBarra: boolean; dentroUnComando: boolean };
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

async function misura(page: Page): Promise<Misura> {
  return page.evaluate(() => {
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
    const sottoIlPunto = document.elementFromPoint(b.x + 5, b.y + 5);
    return {
      reduce: matchMedia("(prefers-reduced-motion: reduce)").matches,
      bar: r(bar),
      chrome: r(chrome),
      comandi,
      angolo: {
        dentroLaBarra: !!sottoIlPunto && bar.contains(sottoIlPunto),
        dentroUnComando: !!sottoIlPunto && !!sottoIlPunto.closest(".raised-control-overlay"),
      },
    };
  });
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

    const m = await misura(page);
    expect(m.reduce, `il contesto deve davvero essere in ${reducedMotion}`).toBe(
      reducedMotion === "reduce",
    );

    // LA PROVA PER INTERO: non `elementFromPoint`, ma il gesto: un click NON
    // forzato sull'angolo, come lo fa chi porta il fuoco fuori da un campo di
    // testo. Timeout corto — se l'angolo torna coperto lo si sa in 5 secondi
    // invece che in 30.
    await test.step(`click non forzato sull'angolo [${reducedMotion}]`, async () => {
      await tabBar.click({ position: { x: 5, y: 5 }, timeout: 5_000 });
    });
    return m;
  } finally {
    await ctx.close();
    await deleteTopic(request, t1.id).catch(() => {});
    await deleteTopic(request, t2.id).catch(() => {});
  }
}

test.describe("@reduced-motion-chrome comandi del chrome sotto movimento ridotto", () => {
  test("stessa posizione, bordi interi, angolo cliccabile — con e senza movimento ridotto", async ({
    browser,
    request,
  }) => {
    const normale = await apriEMisura(browser, request, "no-preference");
    const ridotto = await apriEMisura(browser, request, "reduce");

    // ── 1. NESSUN COMANDO SI SPOSTA ──────────────────────────────────────────
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

    // ── 2. BORDI SU PIXEL INTERI, ALL'INCASSO DELLA RIGA ─────────────────────
    // Il difetto del 08/08 era mezzo pixel: `left: 5.5px` mette il bordo del
    // comando a metà del pixel che il click prende di mira, e l'hit-test
    // arrotonda dalla parte sbagliata. Il primo comando è in testa alla riga,
    // l'ultimo in coda: entrambi a `ROW_INSET` dal proprio bordo.
    for (const c of ridotto.comandi) {
      expect.soft(Number.isInteger(c.rect.x), `bordo sinistro intero: ${c.cls}`).toBe(true);
      expect.soft(Number.isInteger(c.rect.width), `larghezza intera: ${c.cls}`).toBe(true);
    }
    const primo = ridotto.comandi[0];
    const ultimo = ridotto.comandi[ridotto.comandi.length - 1];
    expect(primo.rect.x - ridotto.chrome.x, "il comando in testa sta a ROW_INSET dal bordo").toBe(
      ROW_INSET,
    );
    expect(
      ridotto.chrome.x + ridotto.chrome.width - (ultimo.rect.x + ultimo.rect.width),
      "il comando in coda sta a ROW_INSET dal bordo",
    ).toBe(ROW_INSET);

    // ── 3. L'ANGOLO NEUTRO RISPONDE ALLA BARRA ───────────────────────────────
    // (il click vero l'ha già fatto `apriEMisura`, dentro il suo contesto)
    for (const [nome, m] of [["normale", normale], ["ridotto", ridotto]] as const) {
      expect(m.angolo.dentroUnComando, `(5,5) non deve stare su un comando [${nome}]`).toBe(false);
      expect(m.angolo.dentroLaBarra, `(5,5) deve rispondere alla barra [${nome}]`).toBe(true);
    }
  });
});
