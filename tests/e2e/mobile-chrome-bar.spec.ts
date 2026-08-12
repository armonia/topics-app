/**
 * LA CHROME DEL TELEFONO, MISURATA.
 *
 * Forma decisa da Attilio il 12/08: in alto solo «Topics», in basso tre porte —
 * cerca · aggiungi · board — e la fila che segue la curvatura dello schermo
 * «quando presente nell'iPhone, in modo da ottimizzare al massimo lo spazio».
 *
 * Ognuna di quelle frasi qui è un numero letto dal DOM, non un'impressione:
 *
 *  MOBILE-CHROME-01  in alto non c'è nient'altro che «Topics»
 *  MOBILE-CHROME-02  le tre porte esistono, e il dito ci arriva (≥44px)
 *  MOBILE-CHROME-03  la fila è DRITTA su uno schermo squadrato e CURVA su uno
 *                    con gli angoli tondi — stesso codice, due misure
 *  MOBILE-CHROME-04  «board» è un interruttore: board ⇄ lista, andata e
 *                    ritorno, senza chiudere la board
 *  MOBILE-CHROME-05  la barra di stato non c'è più, e le sue cose (account,
 *                    prestazioni, versione) sono nel menu «Topics»
 *
 * La fascia inferiore si FORZA (`--sab`), non si aspetta un iPhone vero: è
 * esattamente il motivo per cui quell'inset vive in una variabile CSS invece
 * che in una `env()` nuda — `env()` non si può sovrascrivere, e una riga
 * impossibile da provare fuori da un telefono è una riga che si sbaglia a occhi
 * chiusi.
 */
import { test, expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const BASE = E2E_BASE;
const BARRA = '[data-testid="mobile-chrome-bar"]';
const CERCA = '[data-testid="mobile-chrome-search"]';
const AGGIUNGI = '[data-testid="pane-add-menu-trigger"]';
const BOARD = '[data-testid="mobile-chrome-board"]';

/** La fascia dell'home indicator di un iPhone in verticale. */
const FASCIA_IPHONE = 34;
/** Sotto questa quota, su un iPhone, c'è il gesto di sistema e non il bottone. */
const PAVIMENTO_ASSOLUTO = 10;

let topicId: string | null = null;

test.beforeAll(async ({ request }) => {
  const topic = await createTopic(request, "Chrome mobile");
  topicId = topic.id;
  // Una tab aperta: la colonna non è vuota, e l'interruttore della board ha
  // qualcosa a cui tornare.
  await resetPaneStore(request, [topic.id]);
});

test.afterAll(async ({ request }) => {
  await resetPaneStore(request, []);
  if (topicId) await deleteTopic(request, topicId);
});

async function apri(page: Page): Promise<void> {
  await page.goto(BASE);
  await expect(page.locator(BARRA)).toBeVisible();
}

/** Forza la fascia inferiore e sveglia chi la legge (`useMobile` si riaggiorna
 *  su `resize`, che è l'unico evento che accompagna un cambio di inset vero). */
async function fascia(page: Page, px: number): Promise<void> {
  await page.evaluate((v) => {
    document.documentElement.style.setProperty("--sab", `${v}px`);
    window.dispatchEvent(new Event("resize"));
  }, px);
  // Un frame perché la misura (ResizeObserver + layout effect) si posi.
  await page.waitForTimeout(150);
}

/** Il rettangolo di ogni porta, in coordinate di viewport. */
async function porte(page: Page) {
  return page.evaluate(() => {
    const barra = document.querySelector('[data-testid="mobile-chrome-bar"]');
    if (!barra) return [];
    return Array.from(barra.querySelectorAll("button")).map((b) => {
      const r = b.getBoundingClientRect();
      return {
        etichetta: (b.textContent || "").trim(),
        x: r.x, larghezza: r.width, altezza: r.height,
        // Quanto sta SOPRA il bordo inferiore dello schermo.
        daFondo: window.innerHeight - r.bottom,
      };
    });
  });
}

test.describe.serial("La chrome del telefono", () => {
  test("MOBILE-CHROME-01 — in alto c'è «Topics», e nient'altro", async ({ page }) => {
    await apri(page);

    const topics = page.locator('[data-testid="sidebar-topics-menu"]');
    await expect(topics).toBeVisible();

    // Cerca e «+» non sono più lassù: sono scesi nella fila. La prova che NON
    // sono spariti la dà MOBILE-CHROME-02, qui si prova solo che l'alto è
    // sgombro — l'header della colonna è il primo figlio, e ci si guarda dentro
    // invece di cercare in tutta la pagina (in fondo quei due bottoni CI SONO).
    const comandiInAlto = await page.evaluate(() => {
      const colonna = document.querySelector('[aria-label="Topics sidebar"]');
      const header = colonna?.firstElementChild as HTMLElement | null;
      if (!header) return null;
      return Array.from(header.querySelectorAll("button")).map((b) =>
        (b.getAttribute("aria-label") || b.textContent || "").trim(),
      );
    });
    expect(comandiInAlto).not.toBeNull();
    expect(comandiInAlto!.length).toBe(1);
    expect(comandiInAlto![0]).toContain("Topics");

    // E il bersaglio del menu resta quello del dito.
    const box = await topics.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });

  test("MOBILE-CHROME-02 — tre porte, e il dito ci arriva", async ({ page }) => {
    await apri(page);
    await fascia(page, 0);

    for (const sel of [CERCA, AGGIUNGI, BOARD]) {
      await expect(page.locator(BARRA).locator(sel)).toBeVisible();
    }

    const misure = await porte(page);
    expect(misure.length).toBe(3);
    for (const p of misure) {
      expect(p.altezza).toBeGreaterThanOrEqual(44);
      expect(p.larghezza).toBeGreaterThanOrEqual(44);
    }

    // La banda è RISERVATA, non sovrapposta: la radice dell'app finisce dove
    // comincia la fila. Senza questo, la fila coprirebbe il composer.
    const riserva = await page.evaluate(() => {
      const h = getComputedStyle(document.documentElement).getPropertyValue("--mobile-chrome-h").trim();
      const barra = document.querySelector('[data-testid="mobile-chrome-bar"]')!.getBoundingClientRect();
      return { variabile: parseFloat(h), altezzaBarra: barra.height };
    });
    expect(riserva.variabile).toBeGreaterThan(0);
    expect(Math.abs(riserva.variabile - riserva.altezzaBarra)).toBeLessThanOrEqual(1);
  });

  test("MOBILE-CHROME-03 — dritta su schermo squadrato, curva su schermo tondo", async ({ page }) => {
    await apri(page);

    // ── Squadrato: stesso calcolo, raggio zero, fila dritta.
    await fascia(page, 0);
    const dritta = await porte(page);
    const quote = dritta.map((p) => Math.round(p.daFondo));
    expect(new Set(quote).size).toBe(1);
    for (const p of dritta) expect(p.daFondo).toBeGreaterThanOrEqual(PAVIMENTO_ASSOLUTO);

    // ── Angoli tondi: gli estremi SALGONO, quello in mezzo no.
    await fascia(page, FASCIA_IPHONE);
    const curva = await porte(page);
    expect(curva.length).toBe(3);
    const [sx, centro, dx] = curva;

    // Il centro sta sul pavimento: dentro la fascia, sopra l'home indicator.
    expect(Math.round(centro.daFondo)).toBe(FASCIA_IPHONE - 12);
    // I due estremi stanno più in alto del centro, e fra loro sono simmetrici.
    expect(sx.daFondo).toBeGreaterThan(centro.daFondo);
    expect(dx.daFondo).toBeGreaterThan(centro.daFondo);
    expect(Math.abs(sx.daFondo - dx.daFondo)).toBeLessThanOrEqual(1);

    // E nessuna porta finisce sotto la quota dell'home indicator.
    for (const p of curva) expect(p.daFondo).toBeGreaterThanOrEqual(PAVIMENTO_ASSOLUTO);

    // Il bersaglio resta da dito anche agli estremi, che sono quelli che la
    // curva sposta.
    for (const p of curva) {
      expect(p.altezza).toBeGreaterThanOrEqual(44);
      expect(p.larghezza).toBeGreaterThanOrEqual(44);
    }
  });

  test("MOBILE-CHROME-04 — «board» è un interruttore: board ⇄ lista", async ({ page }) => {
    await apri(page);
    await fascia(page, FASCIA_IPHONE);

    const tasto = page.locator(BOARD);
    await expect(tasto).toContainText("Board");

    // Andata: la Kanban compare e il cassetto si toglie di mezzo.
    await tasto.tap();
    await expect(page.locator('[data-pane-id="__board__"], [data-testid="board-pane"]').first()).toBeVisible({ timeout: 15_000 });
    await expect(tasto).toContainText("Tab");

    // Ritorno: torna la lista, e la board NON si è chiusa — è ciò che rende
    // questo un interruttore e non due gesti distinti.
    await tasto.tap();
    await expect(page.locator('[data-testid="sidebar-topic-list"]')).toBeVisible();
    await expect(tasto).toContainText("Board");
    const boardAncoraAperta = await page.evaluate(() =>
      !!document.querySelector('[data-pane-id="__board__"], [data-testid="board-pane"]'),
    );
    expect(boardAncoraAperta).toBe(true);
  });

  test("MOBILE-CHROME-05 — niente barra di stato: account, prestazioni e versione sono nel menu", async ({ page }) => {
    await apri(page);

    // La fascia «Questo computer» non c'è più sotto i 768px.
    await expect(page.locator('[data-testid="sidebar-status-bar"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="device-identity"]')).toHaveCount(0);

    // Le sue tre cose vivono nel menu, che sul telefono è un foglio dal basso.
    await page.locator('[data-testid="sidebar-topics-menu"]').tap();
    const menu = page.locator('[data-testid="sidebar-system-menu"]');
    await expect(menu).toBeVisible();
    await expect(menu.locator('[data-testid="menu-account"]')).toBeVisible();
    await expect(menu.locator('[data-testid="menu-system-status"]')).toBeVisible();
    await expect(menu.locator('[data-testid="menu-version"]')).toBeVisible();

    // Il foglio arriva col pollice: sta in fondo allo schermo, non appeso al
    // titolo in cima.
    // LA GEOMETRIA SI LEGGE A LAYOUT FERMO. Il foglio entra con `slideUp`
    // (0,3s) e `reducedMotion` NON la spegne — la disattiva solo `.anims-paused`
    // — quindi misurare subito dopo il tocco significa misurare un fotogramma
    // dell'animazione: la prima stesura leggeva il bordo inferiore 136px sotto
    // lo schermo, cioè il foglio a metà salita.
    await expect
      .poll(async () => menu.evaluate((el) => Math.round(window.innerHeight - el.parentElement!.getBoundingClientRect().bottom)))
      .toBe(0);

    const quota = await menu.evaluate((el) => {
      const foglio = el.parentElement!.getBoundingClientRect();
      return { fondo: window.innerHeight - foglio.bottom, alto: foglio.top };
    });
    expect(Math.abs(quota.fondo)).toBeLessThanOrEqual(1);
    expect(quota.alto).toBeGreaterThan(100);

    // E le voci si toccano: sotto i 768px il menu è IL menu del telefono, non
    // una tendina da mouse. Le righe erano alte 32 — la variante `coarse:` che
    // doveva ingrassarle non si accende su ogni telefono, e una misura che
    // dipende da un `pointer:` che il browser può non dichiarare non è una
    // misura. Adesso decide `isMobile`, lo stesso predicato dell'header.
    const righe = await page.evaluate(() => {
      const foglio = document.querySelector('[data-testid="sidebar-system-menu"]')!.parentElement!;
      return Array.from(foglio.querySelectorAll("button")).map((b) => ({
        testo: (b.textContent || "").trim().slice(0, 24),
        h: b.getBoundingClientRect().height,
      }));
    });
    expect(righe.length).toBeGreaterThanOrEqual(6);
    for (const r of righe) expect(r.h).toBeGreaterThanOrEqual(44);
  });
});
