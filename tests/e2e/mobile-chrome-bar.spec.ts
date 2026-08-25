/**
 * LA CHROME DEL TELEFONO, MISURATA.
 *
 * Forma decisa da chi usa la app il 12/08 e allargata il 14/08: in alto «Topics» a
 * sinistra e la campanella a DESTRA, in basso quattro porte — cerca · aggiungi ·
 * task · profilo — e la fila che segue la curvatura dello schermo «quando
 * presente nell'iPhone, in modo da ottimizzare al massimo lo spazio».
 *
 * Ognuna di quelle frasi qui è un numero letto dal DOM, non un'impressione:
 *
 *  MOBILE-CHROME-01  in alto non sono risaliti cerca e «+», e la campanella
 *                    sta a destra mentre «Topics» sta a sinistra
 *  MOBILE-CHROME-02  le quattro porte esistono, e il dito ci arriva (≥44px)
 *  MOBILE-CHROME-03  la fila è DRITTA su uno schermo squadrato e CURVA su uno
 *                    con gli angoli tondi — stesso codice, due misure
 *  MOBILE-CHROME-04  «task» è un interruttore: lista dei task ⇄ tab, andata e
 *                    ritorno, senza chiudere la board
 *  MOBILE-CHROME-05  la barra di stato non c'è più; prestazioni e versione sono
 *                    nel menu «Topics», e l'account NON ci è più
 *  MOBILE-CHROME-06  i tasti hanno la faccia di un tasto (campitura a riposo,
 *                    non solo sotto il dito)
 *  MOBILE-CHROME-07  l'angolo esterno segue la curva dello schermo — il primo
 *                    a sinistra, l'ultimo a destra, quelli in mezzo standard —
 *                    e il raggio applicato è quello CONCENTRICO a quello
 *                    dichiarato, non un numero scelto a mano
 *  MOBILE-CHROME-08  la porta del profilo apre la PANE Profilo — una tab, non
 *                    la modale delle Impostazioni — senza passare da nessun menu
 *
 * La fascia inferiore si FORZA (`--sab`), non si aspetta un iPhone vero: è
 * esattamente il motivo per cui quell'inset vive in una variabile CSS invece
 * che in una `env()` nuda — `env()` non si può sovrascrivere, e una riga
 * impossibile da provare fuori da un telefono è una riga che si sbaglia a occhi
 * chiusi.
 *
 * @covers LAYOUT-02
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
const PROFILO = '[data-testid="mobile-chrome-profile"]';

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

/** Il rettangolo di ogni porta, in coordinate di viewport, più la pelle e i
 *  quattro raggi COMPUTATI (non le classi: quello che il browser ha davvero
 *  applicato, che è l'unica cosa che l'occhio vede). */
async function porte(page: Page) {
  return page.evaluate(() => {
    const barra = document.querySelector('[data-testid="mobile-chrome-bar"]');
    if (!barra) return [];
    return Array.from(barra.querySelectorAll("button")).map((b) => {
      const r = b.getBoundingClientRect();
      const s = getComputedStyle(b);
      const px = (v: string) => parseFloat(v) || 0;
      return {
        etichetta: (b.textContent || "").trim(),
        x: r.x, larghezza: r.width, altezza: r.height,
        // Quanto sta SOPRA il bordo inferiore dello schermo.
        daFondo: window.innerHeight - r.bottom,
        // E quanto dista dal bordo laterale più vicino: è il gioco che entra
        // nel raggio concentrico.
        daBordo: Math.min(r.x, window.innerWidth - r.right),
        fondo: s.backgroundColor,
        raggi: {
          altoSx: px(s.borderTopLeftRadius),
          altoDx: px(s.borderTopRightRadius),
          bassoDx: px(s.borderBottomRightRadius),
          bassoSx: px(s.borderBottomLeftRadius),
        },
      };
    });
  });
}

/** Il raggio dello schermo DICHIARATO da chi lo sa (una shell nativa). Il
 *  modulo lo preferisce alla stima, ed è ciò che rende questa misura un
 *  confronto e non una tautologia: si dichiara R, si legge il raggio applicato
 *  e si verifica che sia il concentrico di QUEL R. */
async function raggioSchermoDichiarato(page: Page, px: number | null): Promise<void> {
  await page.evaluate((v) => {
    if (v === null) document.documentElement.style.removeProperty("--screen-corner-radius");
    else document.documentElement.style.setProperty("--screen-corner-radius", `${v}px`);
    window.dispatchEvent(new Event("resize"));
  }, px);
  await page.waitForTimeout(150);
}

/** Un colore è una campitura solo se ha corpo: `transparent` e alpha 0 no. */
function haCampitura(colore: string): boolean {
  if (!colore || colore === "transparent") return false;
  const m = colore.match(/rgba?\(([^)]+)\)/);
  if (!m) return false;
  const parti = m[1].split(",").map((v) => parseFloat(v));
  return parti.length < 4 || parti[3] > 0;
}

test.describe.serial("La chrome del telefono", () => {
  test("MOBILE-CHROME-01 — in alto «Topics» a sinistra, la campanella a destra", async ({ page }) => {
    await apri(page);

    const topics = page.locator('[data-testid="sidebar-topics-menu"]');
    await expect(topics).toBeVisible();

    // Cerca e «+» non sono più lassù: sono scesi nella fila. La prova che NON
    // sono spariti la dà MOBILE-CHROME-02, qui si prova che lassù restano due
    // comandi soli e da che parte stanno — l'header della colonna è il primo
    // figlio, e ci si guarda dentro invece di cercare in tutta la pagina (in
    // fondo quei due bottoni CI SONO).
    const alto = await page.evaluate(() => {
      const colonna = document.querySelector('[aria-label="Topics sidebar"]');
      const header = colonna?.firstElementChild as HTMLElement | null;
      if (!header) return null;
      const riga = header.getBoundingClientRect();
      return {
        meta: riga.left + riga.width / 2,
        destra: riga.right,
        comandi: Array.from(header.querySelectorAll("button")).map((b) => {
          const r = b.getBoundingClientRect();
          return {
            nome: (b.getAttribute("aria-label") || b.textContent || "").trim(),
            testid: b.getAttribute("data-testid") ?? "",
            centro: r.left + r.width / 2,
            fine: r.right,
            altezza: r.height,
            larghezza: r.width,
          };
        }),
      };
    });
    expect(alto).not.toBeNull();
    // Il contratto è QUALI comandi non stanno più lassù, non quanti sono: la
    // riga contava i bottoni (`length === 1`) ed è diventata rossa il giorno
    // in cui la campanella delle notifiche è salita nell'header (8705c0b2, il
    // 12/08, poche ore dopo questa fila) — un rosso che non descriveva nessun
    // difetto. Una lista chiusa avrebbe rifiutato anche la prossima aggiunta
    // legittima; l'elenco dei PROSCRITTI no. Vale anche per il conteggio che
    // avevo scritto qui («due, non tre»): sarebbe caduto alla porta successiva.
    for (const sceso of ["Cerca", "Search", "Aggiungi"]) {
      expect(alto!.comandi.some((c) => c.nome.includes(sceso))).toBe(false);
    }

    const titolo = alto!.comandi.find((c) => c.testid === "sidebar-topics-menu");
    const campanella = alto!.comandi.find((c) => c.testid === "notification-history-button");
    expect(titolo).toBeTruthy();
    expect(campanella).toBeTruthy();

    // «Da un lato topics, dall'altro le notifiche» (chi usa la app, 14/08): non basta
    // che esistano entrambe, devono stare da parti OPPOSTE della riga. Prima la
    // campanella era attaccata al titolo, cioè entrambe nella metà sinistra —
    // ed è esattamente la misura che quel difetto passava.
    expect(titolo!.centro).toBeLessThan(alto!.meta);
    expect(campanella!.centro).toBeGreaterThan(alto!.meta);
    // E ci sta DAVVERO in coda: a filo del bordo destro, non a mezza strada.
    expect(alto!.destra - campanella!.fine).toBeLessThanOrEqual(12);

    // I bersagli restano quelli del dito.
    for (const c of alto!.comandi) {
      expect(c.altezza).toBeGreaterThanOrEqual(44);
      expect(c.larghezza).toBeGreaterThanOrEqual(44);
    }
  });

  test("MOBILE-CHROME-02 — quattro porte, e il dito ci arriva", async ({ page }) => {
    await apri(page);
    await fascia(page, 0);

    for (const sel of [CERCA, AGGIUNGI, BOARD, PROFILO]) {
      await expect(page.locator(BARRA).locator(sel)).toBeVisible();
    }

    const misure = await porte(page);
    expect(misure.length).toBe(4);
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

    // ── Angoli tondi: gli estremi SALGONO, quelli in mezzo no.
    // Con quattro scatole i «centri» sono due, e la legge non cambia: sale chi
    // sta entro il raggio dal bordo laterale, e nessun altro. È il motivo per
    // cui la quarta porta non ha richiesto un ramo nuovo in `alzateFila`.
    await fascia(page, FASCIA_IPHONE);
    const curva = await porte(page);
    expect(curva.length).toBe(4);
    const [sx, centroSx, centroDx, dx] = curva;

    // I due in mezzo stanno sul pavimento: dentro la fascia, sopra l'home
    // indicator, e l'arco lì non arriva.
    expect(Math.round(centroSx.daFondo)).toBe(FASCIA_IPHONE - 12);
    expect(Math.round(centroDx.daFondo)).toBe(FASCIA_IPHONE - 12);
    // I due estremi stanno più in alto, e fra loro sono simmetrici.
    expect(sx.daFondo).toBeGreaterThan(centroSx.daFondo);
    expect(dx.daFondo).toBeGreaterThan(centroDx.daFondo);
    expect(Math.abs(sx.daFondo - dx.daFondo)).toBeLessThanOrEqual(1);

    // E nessuna porta finisce sotto la quota dell'home indicator.
    for (const p of curva) expect(p.daFondo).toBeGreaterThanOrEqual(PAVIMENTO_ASSOLUTO);

    // Il bersaglio resta da dito anche agli estremi, che sono quelli che la
    // curva sposta.
    for (const p of curva) {
      expect(p.altezza).toBeGreaterThanOrEqual(44);
      expect(p.larghezza).toBeGreaterThanOrEqual(44);
    }

    // A FILO: il primo e l'ultimo toccano il bordo dello schermo, e ci arrivano
    // con l'angolo esterno tondo. Senza quell'angolo la stessa posizione
    // costerebbe tutto il raggio dell'arco di alzata, cioè più dell'altezza del
    // tasto: è il conto di `alzataCurva`.
    expect(Math.round(sx.daBordo)).toBe(0);
    expect(Math.round(dx.daBordo)).toBe(0);
    expect(sx.raggi.bassoSx).toBeGreaterThan(sx.raggi.altoSx);
    expect(dx.raggi.bassoDx).toBeGreaterThan(dx.raggi.altoDx);
  });

  test("MOBILE-CHROME-03b — i quattro tasti si dividono TUTTA la larghezza", async ({ page }) => {
    await apri(page);
    await fascia(page, FASCIA_IPHONE);

    const misure = await porte(page);
    expect(misure.length).toBe(4);

    // Larghi uguale: quattro porte che valgono uguale non hanno bersagli
    // diversi.
    const larghezze = misure.map((p) => Math.round(p.larghezza));
    expect(new Set(larghezze).size).toBe(1);

    // E fra loro, e ai lati, non resta barra premibile per finta: la somma dei
    // tasti più i tre passi è la larghezza intera dello schermo.
    const larghezzaSchermo = await page.evaluate(() => window.innerWidth);
    const primo = misure[0];
    const ultimo = misure[misure.length - 1];
    expect(Math.round(primo.x)).toBe(0);
    expect(Math.round(ultimo.x + ultimo.larghezza)).toBe(Math.round(larghezzaSchermo));
    for (let i = 1; i < misure.length; i++) {
      const buco = misure[i].x - (misure[i - 1].x + misure[i - 1].larghezza);
      expect(Math.round(buco)).toBeLessThanOrEqual(8);
    }
  });

  test("MOBILE-CHROME-04 — «task» è un interruttore: lista dei task ⇄ tab", async ({ page }) => {
    await apri(page);
    await fascia(page, FASCIA_IPHONE);

    // La porta si chiama come la cosa che apre. «Board» era il nome del
    // contenitore, e chi cercava i propri task cercava la parola «task»
    // (chi usa la app, 14/08: «il tasto per accedere velocemente alla lista dei task»).
    const tasto = page.locator(BOARD);
    await expect(tasto).toContainText("Task");

    // Andata: la Kanban compare e il cassetto si toglie di mezzo.
    //
    // SI GUARDA LA BOARD, NON LA SUA TAB. Questo test cercava
    // `[data-pane-id="__board__"]`, che è la TESSERA nella striscia delle tab —
    // e su un telefono quella striscia non esiste più da `b58b01a9` («da mobile
    // la barra delle tab in alto non serve, c'è già la lista delle tab»), che è
    // arrivata poche ore dopo questo file. Da allora il locator non trovava
    // niente mentre la board era a schermo intero: il rosso diceva «la board non
    // si apre» di una board aperta. `kanban-board` è il marcatore della pane
    // stessa, quindi risponde alla domanda vera su entrambe le sponde.
    await tasto.tap();
    await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 15_000 });
    await expect(tasto).toContainText("Tab");

    // Ritorno: torna la lista, e la board NON si è chiusa — è ciò che rende
    // questo un interruttore e non due gesti distinti.
    await tasto.tap();
    await expect(page.locator('[data-testid="sidebar-topic-list"]')).toBeVisible();
    await expect(tasto).toContainText("Task");
    // Montata, non per forza in primo piano: il cassetto le sta davanti.
    await expect(page.getByTestId("kanban-board")).toHaveCount(1);
  });

  test("MOBILE-CHROME-05 — nel menu restano prestazioni e versione, l'account no", async ({ page }) => {
    await apri(page);

    // La fascia «Questo computer» non c'è più sotto i 768px.
    await expect(page.locator('[data-testid="sidebar-status-bar"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="identity-row-me"]')).toHaveCount(0);

    // Quel che resta vive nel menu, che sul telefono è un foglio dal basso.
    await page.locator('[data-testid="sidebar-topics-menu"]').tap();
    const menu = page.locator('[data-testid="sidebar-system-menu"]');
    await expect(menu).toBeVisible();
    await expect(menu.locator('[data-testid="menu-system-status"]')).toBeVisible();
    await expect(menu.locator('[data-testid="menu-version"]')).toBeVisible();

    // L'ACCOUNT NON C'È PIÙ QUI, ed è la metà che conta della richiesta del
    // 14/08: «il tasto del profilo, togliendolo dal menu di Topics». Lasciarlo
    // anche qui avrebbe soddisfatto la prima metà e disatteso la seconda, e da
    // fuori sarebbe sembrato fatto. La porta adesso è in fondo allo schermo, e
    // che ci PORTI davvero lo prova MOBILE-CHROME-06.
    await expect(menu.locator('[data-testid="menu-account"]')).toHaveCount(0);

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
    // Cinque e non sei: la voce dell'account se n'è andata, e questa soglia è
    // scesa con lei invece di restare indietro a coprire il buco.
    expect(righe.length).toBeGreaterThanOrEqual(5);
    for (const r of righe) expect(r.h).toBeGreaterThanOrEqual(44);
  });

  test("MOBILE-CHROME-06 — hanno la faccia di un tasto, non di un link", async ({ page }) => {
    await apri(page);
    await fascia(page, FASCIA_IPHONE);

    // La prima stesura le lasciava piatte: colore SOLO sotto il dito. Un
    // comando che si vede solo mentre lo premi è un comando che non si trova
    // («devono avere il design classico dei tasti, come il + che c'era»).
    // A riposo, quindi: campitura vera su tutte e quattro.
    const misure = await porte(page);
    expect(misure.length).toBe(4);
    for (const p of misure) {
      expect(haCampitura(p.fondo)).toBe(true);
    }

    // E il filo di luce c'è: `edge-lit` disegna il perimetro in un `::before`
    // che eredita il raggio, quindi la pelle segue la curva invece di
    // tagliarla.
    const filo = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid="mobile-chrome-bar"] button')).map((b) => ({
        classe: b.className.includes("edge-lit"),
        ombra: getComputedStyle(b, "::before").boxShadow,
        raggioFilo: getComputedStyle(b, "::before").borderBottomLeftRadius,
      })),
    );
    for (const f of filo) {
      expect(f.classe).toBe(true);
      expect(f.ombra).not.toBe("none");
    }
    // Il filo dell'estremo sinistro porta lo STESSO raggio del bottone: se lo
    // ereditasse male si vedrebbe un angolo dritto disegnato sopra una curva.
    expect(parseFloat(filo[0].raggioFilo)).toBeCloseTo(misure[0].raggi.bassoSx, 1);
  });

  test("MOBILE-CHROME-07 — l'angolo esterno è il CONCENTRICO di quello dello schermo", async ({ page }) => {
    await apri(page);
    await fascia(page, FASCIA_IPHONE);

    /** Il raggio standard di un tasto della fila, quando nessun arco lo tocca. */
    const STANDARD = 12;
    /** Mezza altezza: il massimo che un bottone da 44 può portare. */
    const TETTO = 22;

    // ── Schermo squadrato: nessuna curva da seguire, tutti e dodici gli
    //    angoli sono quelli standard. Nessun ramo dedicato, stesso codice.
    await fascia(page, 0);
    await raggioSchermoDichiarato(page, null);
    for (const p of await porte(page)) {
      expect(p.raggi.bassoSx).toBeCloseTo(STANDARD, 1);
      expect(p.raggi.bassoDx).toBeCloseTo(STANDARD, 1);
      expect(p.raggi.altoSx).toBeCloseTo(STANDARD, 1);
      expect(p.raggi.altoDx).toBeCloseTo(STANDARD, 1);
    }

    // ── Schermo tondo. Il raggio NON si stima qui: lo si DICHIARA, e si
    //    verifica che quello applicato sia `R − gioco` — cioè concentrico a
    //    quello dichiarato — con mezza altezza come tetto. Tre valori di R e
    //    tre risposte diverse: se fosse un numero scelto a mano non si
    //    muoverebbe.
    await fascia(page, FASCIA_IPHONE);
    // I TRE R SI RICAVANO DAL GIOCO MISURATO, non si scrivono a mano. Da quando
    // la fila arriva al bordo del vetro il gioco e' 0, e la vecchia terna
    // (28/40/54) dava tre volte il TETTO: tre risposte identiche non
    // distinguono la legge da una costante nel foglio, che e' esattamente cio'
    // che questo caso deve saper vedere. Ricavandoli, la terna resta
    // discriminante anche se un domani la fila si stacca dal bordo.
    const gioco = (await porte(page))[0]!.daBordo;
    const RAGGI = [gioco + STANDARD, gioco + 17, gioco + TETTO + 18];
    for (const R of RAGGI) {
      await raggioSchermoDichiarato(page, R);
      // Le porte sono quattro, quindi i «centri» sono due: quello che conta è
      // il PRIMO e l'ULTIMO, cioè chi tocca i bordi. Aggiungere una porta non
      // ha cambiato la legge, ha cambiato quante scatole non la incontrano.
      const misure = await porte(page);
      const sx = misure[0];
      const dx = misure[misure.length - 1];
      const centrali = misure.slice(1, -1);

      const atteso = (gioco: number) => Math.min(Math.max(R - gioco, STANDARD), TETTO);

      // Sinistra curva A SINISTRA: l'angolo basso sinistro è l'unico che
      // cambia, gli altri tre restano standard.
      expect(sx.raggi.bassoSx).toBeCloseTo(atteso(sx.daBordo), 1);
      expect(sx.raggi.bassoDx).toBeCloseTo(STANDARD, 1);
      expect(sx.raggi.altoSx).toBeCloseTo(STANDARD, 1);

      // Destra curva A DESTRA, specularmente.
      expect(dx.raggi.bassoDx).toBeCloseTo(atteso(dx.daBordo), 1);
      expect(dx.raggi.bassoSx).toBeCloseTo(STANDARD, 1);
      expect(dx.raggi.altoDx).toBeCloseTo(STANDARD, 1);

      // I centrali hanno la curva STANDARD: nessuno dei due bordi li raggiunge.
      for (const centro of centrali) {
        expect(centro.daBordo).toBeGreaterThan(R);
        expect(centro.raggi.bassoSx).toBeCloseTo(STANDARD, 1);
        expect(centro.raggi.bassoDx).toBeCloseTo(STANDARD, 1);
      }
    }

    // E I TRE R NON DANNO LA STESSA RISPOSTA. È la prova che il numero arriva
    // dal raggio dello schermo e non da una costante nel foglio: uno schermo
    // appena curvo dà l'angolo standard, uno di mezzo dà un valore suo, uno
    // molto curvo batte contro il tetto. Se un giorno tornassero tutti e tre
    // uguali, questo caso resterebbe verde misurando niente — ed è successo.
    await raggioSchermoDichiarato(page, RAGGI[1]!);
    const medio = (await porte(page))[0]!;
    await raggioSchermoDichiarato(page, RAGGI[2]!);
    const largo = (await porte(page))[0]!;
    expect(medio.raggi.bassoSx).toBeGreaterThan(STANDARD);
    expect(medio.raggi.bassoSx).toBeLessThan(largo.raggi.bassoSx);
    expect(largo.raggi.bassoSx).toBeCloseTo(TETTO, 1);

    // LA PROVA CHE SI GUARDA. Uno screenshot nudo non basta: il browser
    // disegna un rettangolo, quindi l'arco a cui i tasti si allineano NON è
    // nell'immagine e non c'è niente da confrontare. Si disegna: un filo alla
    // curva DICHIARATA, e sotto ci si vede se i due estremi la seguono o la
    // tagliano. È un righello sovrapposto, non un effetto.
    await raggioSchermoDichiarato(page, RAGGI[2]!);
    await page.evaluate((R) => {
      const filo = document.createElement("div");
      filo.id = "righello-arco";
      Object.assign(filo.style, {
        position: "fixed", inset: "0", zIndex: "9999", pointerEvents: "none",
        border: "1px dashed rgba(255,0,0,0.85)", borderRadius: `${R}px`,
      });
      document.body.appendChild(filo);
    }, RAGGI[2]!);
    await page.screenshot({
      path: "test-results/mobile-chrome-curva.png",
      // Il fondo dello schermo, non la sola barra: l'arco si giudica su quanto
      // di angolo si vede, e una striscia alta 90px non ne mostra abbastanza.
      clip: { x: 0, y: 844 - 200, width: 390, height: 200 },
    });
    await page.evaluate(() => document.getElementById("righello-arco")?.remove());
  });

  test("MOBILE-CHROME-08 — la porta del profilo apre la PANE Profilo, non la modale", async ({ page }) => {
    await apri(page);
    await fascia(page, FASCIA_IPHONE);

    // Si arriva dalla FILA, non dal menu: il menu qui non si apre mai, ed è il
    // punto di tutto il cambio. La faccia è il bersaglio.
    const profilo = page.locator(PROFILO);
    await expect(profilo).toBeVisible();
    await expect(profilo).toContainText("Profilo");
    await profilo.tap();

    // La PANE, cioè una tab come Dashboard e Board. Portava a Impostazioni →
    // Profilo: un pannello sopra la app, da richiudere per tornare a lavorare.
    // Le statistiche sono qualcosa che si va a guardare, e una cosa che si
    // guarda vuole una tab.
    await expect(page.locator('[data-testid="profile-pane"]')).toBeVisible();

    // E la modale NON si apre: due porte per la stessa stanza sarebbero il
    // difetto che questo cambio esiste per togliere. La sezione in Impostazioni
    // resta raggiungibile da lì, non da qui.
    await expect(page.locator('[data-testid="settings-panel"]')).toHaveCount(0);

    // Il menu «Topics» è rimasto chiuso per tutto il tragitto.
    await expect(page.locator('[data-testid="sidebar-system-menu"]')).toHaveCount(0);
  });
});
