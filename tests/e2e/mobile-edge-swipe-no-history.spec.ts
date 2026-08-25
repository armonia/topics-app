import { test, expect, type Page } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";

/**
 * IL BORDO E' DEL MENU, NON DELLA CRONOLOGIA.
 *
 * chi usa la app, dal telefono: trascinando dal bordo sinistro la pagina torna
 * indietro nella cronologia invece di aprire il cassetto. Vale anche in avanti,
 * dal bordo destro.
 *
 * ── Perche' questo test non guarda solo l'URL ────────────────────────────────
 * In headless non esiste il gesto di sistema che fa tornare indietro Safari su
 * iPhone: nessun input, vero o finto, lo puo' innescare qui. Un test che si
 * limitasse ad asserire «l'URL non e' cambiato» sarebbe quindi verde anche a
 * codice rotto. Sarebbe un'asserzione che non puo' fallire, cioe' niente.
 *
 * Quello che si puo' misurare, e che e' la LEVA vera su ogni motore, e' CHI si
 * prende il tocco e QUANDO. Il browser decide se il trascinamento dal margine e'
 * suo guardando i primi eventi: se la pagina non li ha ancora rivendicati con
 * `preventDefault`, il gesto e' del browser e da li' in poi non si torna
 * indietro. Quindi si misura il PRIMO `touchmove`, non l'esito.
 *
 * ── Cosa e' rosso prima del fix, e cosa no ──────────────────────────────────
 *  1. Dal bordo DESTRO non ascoltava nessuno: nessun `preventDefault`, mai. Li'
 *     non c'e' un cassetto da tirare, quindi non c'era nemmeno un gesto, e il
 *     trascinamento restava del browser, che lo usa per andare AVANTI.
 *  2. `overscroll-behavior-x` non era dichiarato su nessuno dei tre contenitori
 *     di radice, quindi un trascinamento orizzontale che sfonda il contenuto
 *     diventava una navigazione.
 *
 * Il bordo SINISTRO, misurato, era gia' verde qui, e vale la pena scrivere
 * perche': Chromium in modo mobile non consegna nessun `touchmove` finche' il
 * dito non esce dalla soglia di slop, quindi il primo evento che la pagina vede
 * dichiara gia' una trentina di pixel. La vecchia attesa di 8px non si vedeva
 * dal test perche' quegli 8px erano sotto il pavimento del motore. Resta un
 * difetto vero sugli altri motori, dove la soglia e' diversa, e il fix la toglie
 * di mezzo decidendo l'asse al primo movimento invece che all'ottavo pixel: qui
 * quel test fa da guardia contro le regressioni, non da prova del difetto.
 *
 * L'ultimo test (il cassetto si apre) e' verde anche prima: sta qui per
 * impedire che il fix spenga il gesto invece di difenderlo.
 *
 * I tocchi arrivano da `Input.dispatchTouchEvent` via CDP, non da
 * `dispatchEvent` costruito in pagina: gli eventi sintetici non passano dalla
 * pipeline di input del browser, quindi non potrebbero ne' innescare ne'
 * escludere una navigazione.
 *
 * @covers LAYOUT-02
 */

hermetic(test);

const SIDEBAR = '[aria-label="Topics sidebar"]';

/** Lo stato del cassetto sopravvive al reload, quindi va DICHIARATO: senza,
 *  questo test eredita l'ultimo gesto di chi e' passato di qui. */
async function apriApp(page: Page, chiuso: boolean): Promise<void> {
  await page.addInitScript((c) => {
    localStorage.setItem("topics-mobile-drawer-collapsed", c ? "1" : "0");
  }, chiuso);
  await page.goto("/");
  await page.waitForSelector(SIDEBAR, { state: "attached", timeout: 15_000 });
  // La colonna deve essere FERMA prima che il dito la tocchi: un campione preso
  // dentro la transizione di riposo parla dell'animazione, non del gesto.
  await expect
    .poll(async () => (await bordoDestro(page)) <= 0, {
      message: "il cassetto deve posarsi prima del gesto",
      timeout: 5_000,
    })
    .toBe(chiuso);
}

async function bordoDestro(page: Page): Promise<number> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? el.getBoundingClientRect().right : -1;
  }, SIDEBAR);
}

interface Spia {
  mosse: number;
  primaPrevenuta: boolean;
  /**
   * Di quanto si era spostato il dito al PRIMO movimento consegnato.
   *
   * MISURATO, e cambia cosa ha senso pretendere: Chromium in modo mobile non
   * consegna NESSUN `touchmove` finche' il dito non esce dalla sua soglia di
   * slop. Con passi da 2px il primo evento che arriva alla pagina ne dichiara
   * gia' 33,8. Quindi «rivendicare entro i primi 6px» non e' un requisito
   * severo: e' irraggiungibile, perche' quei pixel la pagina non li vede
   * proprio. Si misura la prontezza sul primo evento OSSERVABILE, che e' il
   * primo istante in cui la pagina puo' fare qualcosa.
   */
  primoDx: number;
  prevenute: number;
  popstate: number;
  href: string;
  lunghezza: number;
}

/**
 * La spia sta su `window` in BOLLA: window riceve dopo document, quindi qui
 * `defaultPrevented` dice se il gesto della pagina si e' gia' preso il tocco.
 */
async function spia(page: Page): Promise<void> {
  await page.evaluate(() => {
    interface Conto {
      mosse: number; prima: boolean | null; primoDx: number;
      prevenute: number; pop: number; x0: number | null;
    }
    const w = window as unknown as { __bordo?: Conto };
    w.__bordo = { mosse: 0, prima: null, primoDx: -1, prevenute: 0, pop: 0, x0: null };
    window.addEventListener("popstate", () => { w.__bordo!.pop += 1; });
    window.addEventListener("touchstart", (e: TouchEvent) => {
      if (e.touches[0]) w.__bordo!.x0 = e.touches[0].clientX;
    });
    window.addEventListener("touchmove", (e: TouchEvent) => {
      const c = w.__bordo!;
      c.mosse += 1;
      if (e.defaultPrevented) c.prevenute += 1;
      if (c.prima === null) {
        c.prima = e.defaultPrevented;
        const t = e.touches[0];
        c.primoDx = t && c.x0 !== null ? Math.abs(t.clientX - c.x0) : -1;
      }
    });
  });
}

async function leggi(page: Page): Promise<Spia> {
  return page.evaluate(() => {
    interface Conto {
      mosse: number; prima: boolean | null; primoDx: number;
      prevenute: number; pop: number;
    }
    const c = (window as unknown as { __bordo?: Conto }).__bordo;
    return {
      mosse: c?.mosse ?? -1,
      primaPrevenuta: c?.prima === true,
      primoDx: c?.primoDx ?? -1,
      prevenute: c?.prevenute ?? -1,
      popstate: c?.pop ?? -1,
      href: location.href,
      lunghezza: history.length,
    };
  });
}

/**
 * Un dito vero. I primi passi sono MINUTI (2px) apposta: e' li' che si decide
 * di chi e' il gesto, e un primo passo da 28px renderebbe la misura cieca
 * perche' avrebbe gia' superato ogni soglia.
 */
async function dito(page: Page, opts: { da: number; a: number; y: number }): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const { da, a, y } = opts;
  const verso = a > da ? 1 : -1;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: da, y }] });
  // I primi quattro passi sono minuti E lenti: distanziarli di 60ms impedisce a
  // Chromium di fonderli in un unico movimento gia' lungo, che renderebbe cieca
  // la misura di prontezza. I dieci successivi corrono a 16ms perche' li' conta
  // solo che la corsa arrivi in fondo.
  const fini: number[] = [];
  for (let i = 1; i <= 4; i++) fini.push(da + verso * 2 * i);
  const grossi: number[] = [];
  for (let i = 1; i <= 10; i++) grossi.push(da + ((a - da) * i) / 10);
  for (const x of fini) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
    await page.waitForTimeout(60);
  }
  for (const x of grossi) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

test.describe("il bordo e' del menu", () => {
  test("dal bordo sinistro il gesto e' rivendicato al PRIMO movimento", async ({ page }) => {
    await apriApp(page, true);
    await spia(page);
    const prima = await leggi(page);

    await dito(page, { da: 2, a: 340, y: 420 });
    await page.waitForTimeout(700);
    const dopo = await leggi(page);

    expect(dopo.mosse, "il dito deve aver mosso davvero").toBeGreaterThan(4);
    // Il primo evento che la pagina PUO' vedere deve essere gia' suo, e nessuno
    // dei successivi deve sfuggire: un solo movimento non rivendicato in mezzo
    // alla corsa e' una finestra in cui il browser puo' prendersi il gesto.
    expect(dopo.primaPrevenuta, "il primo touchmove dal bordo deve essere prevenuto").toBe(true);
    expect(dopo.prevenute, "nessun movimento del gesto deve sfuggire").toBe(dopo.mosse);
    expect(dopo.href, "l'URL non si muove").toBe(prima.href);
    expect(dopo.lunghezza, "la cronologia non cresce").toBe(prima.lunghezza);
    expect(dopo.popstate, "nessuna navigazione nella cronologia").toBe(0);
  });

  test("dal bordo destro il gesto e' rivendicato, e non porta avanti", async ({ page }) => {
    await apriApp(page, true);
    await spia(page);
    const prima = await leggi(page);
    const larghezza = page.viewportSize()!.width;

    await dito(page, { da: larghezza - 2, a: larghezza - 340, y: 420 });
    await page.waitForTimeout(700);
    const dopo = await leggi(page);

    expect(dopo.mosse, "il dito deve aver mosso davvero").toBeGreaterThan(4);
    expect(dopo.primaPrevenuta, "il primo touchmove dal bordo destro deve essere prevenuto").toBe(true);
    expect(dopo.prevenute, "nessun movimento del gesto deve sfuggire").toBe(dopo.mosse);
    expect(dopo.href, "l'URL non si muove").toBe(prima.href);
    expect(dopo.lunghezza, "la cronologia non cresce").toBe(prima.lunghezza);
    expect(dopo.popstate, "nessuna navigazione in avanti").toBe(0);
  });

  test("i contenitori di radice rifiutano l'overscroll orizzontale", async ({ page }) => {
    await apriApp(page, true);
    const misura = await page.evaluate(() => {
      const val = (el: Element) => getComputedStyle(el).getPropertyValue("overscroll-behavior-x");
      const root = document.getElementById("root");
      return {
        html: val(document.documentElement),
        body: val(document.body),
        root: root ? val(root) : "assente",
      };
    });
    // `contain` ferma la catena, `none` ferma anche il gesto di navigazione:
    // qui serve il secondo.
    expect(misura.html, "html").toBe("none");
    expect(misura.body, "body").toBe("none");
    expect(misura.root, "#root").toBe("none");
  });

  test("il cassetto si apre lo stesso: il fix difende il gesto, non lo spegne", async ({ page }) => {
    await apriApp(page, true);
    expect(await bordoDestro(page), "parte chiuso").toBeLessThanOrEqual(0);

    await dito(page, { da: 2, a: 340, y: 420 });
    // La posa dura al massimo 300ms, piu' il travaso dello stato React.
    await expect
      .poll(async () => (await bordoDestro(page)) > 200, {
        message: "dopo il gesto il cassetto deve essere aperto",
        timeout: 4_000,
      })
      .toBe(true);
  });
});
