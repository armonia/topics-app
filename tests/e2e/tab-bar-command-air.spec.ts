/**
 * L'ARIA ATTORNO AL «+» E AL TASTO CHE RIAPRE LA COLONNA — misurata sulla barra.
 *
 * «Il + e apri sidebar dovrebbero avere aria intorno uguale, anche rispetto alle
 * tab a inizio e fine scroll» (Attilio, 08/08), e poi due volte ancora: «senza
 * aria giusta rispetto ai bordi e alle tab» (09/08) e «hai fatto i tasti più
 * piccoli ma non dovevi, dovevi solo stare attento allo spazio verso l'inizio e
 * fine dello scroll» (09/08).
 *
 * Tre giri, tre errori diversi, e nessuno dei tre poteva essere visto da un test
 * unitario — le costanti erano coerenti fra loro ogni volta:
 *
 *  1. `paddingLeft: 30` inline a sinistra contro una riserva derivata a destra:
 *     due grammatiche per i due capi della stessa barra;
 *  2. specchiate, ma calcolate come `box + incasso VERTICALE` — la strip finiva
 *     esattamente sul bordo della scatola del bottone, zero aria fra tab e
 *     comando, e col dito il bottone stava DUE pixel dal bordo della riga;
 *  3. il comando rimpicciolito a 28 fisso per far tornare il verticale. Ma i 2px
 *     di aria misurati non venivano dal box: venivano da un DISACCORDO DI
 *     PREDICATO. La tab decideva la propria altezza con `isTouch` (JS), il
 *     comando col breakpoint `md:` (larghezza). Dove i due non coincidono — una
 *     finestra stretta senza touch, che è anche quello che misura questa suite —
 *     la tab veniva 28 e il comando 36 nella stessa riga da 40.
 *
 * Quindi si misura QUI, sull'elemento renderizzato, ai due lati del breakpoint.
 *
 * SOTTO I 768 LA STRISCIA NON C'È PIÙ (chrome mobile del 12/08). La riga
 * standalone lascia il posto al NOME della superficie
 * (`StandaloneChatGroup` → `mobile-pane-title`) e dei due comandi resta solo
 * quello che riapre la colonna: il «+» ha il suo gemello nella fila in basso
 * (`MobileChromeBar`), quindi lì sparisce. Il contratto che questo file misura
 * non è però cambiato — è quello scritto accanto a quel ramo, «la riga si
 * svuota, non si sposta»: stesso box da dito, stesso incasso dal bordo, e il
 * nome che parte esattamente dove partiva la striscia. Per questo il caso a
 * 390px misura QUELLA riga invece di cercare una striscia che non esiste: fino
 * al 15/08 la cercava lo stesso e i quattro test morivano dentro
 * `page.evaluate` con «getComputedStyle: parameter 1 is not of type Element»,
 * cioè su un locator vuoto invece che su una misura.
 */
import { test, expect, type Page } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/** L'incasso della colonna: `ROW_INSET` in `lib/selectionStyles.ts`. */
const ROW_INSET = 6;

/** I due box di `ROW_ACTION_BOX` (`w-9 h-9 md:w-7 md:h-7`), in pixel. */
const BOX_MOUSE = 28;
const BOX_DITO = 36;

/** La riserva che un capo della riga si tiene per il suo comando:
 *  bordo + box + bordo. È `CHROME_ROW_ACTION_RESERVE_LEFT` (`pl-[48px]
 *  md:pl-[40px]`) e la riserva derivata a destra, dette in numeri. */
const riserva = (box: number) => ROW_INSET + box + ROW_INSET;

const ids: string[] = [];
const nomi: string[] = [];

test.beforeAll(async ({ request }) => {
  const stamp = Date.now();
  // Due tab: una barra con una sola tab non può mostrare il gap fra tab e
  // comando ai due capi.
  for (let i = 0; i < 2; i++) {
    const n = `E2E-AriaComando-${stamp}-${i}`;
    const t = await createTopic(request, n);
    ids.push(t.id);
    nomi.push(n);
  }
});

test.afterAll(async ({ request }) => {
  for (const id of ids) await deleteTopic(request, id).catch(() => {});
});

interface Comando {
  titolo: string;
  w: number;
  h: number;
  sopra: number;
  sotto: number;
  daSx: number;
  daDx: number;
}

interface Riga {
  barra: { h: number };
  /** Quante strisce scorrevoli ci sono nella riga. Sotto i 768 deve essere 0. */
  strisce: number;
  /** La striscia delle tab, quando c'è. */
  strip: { pl: number; pr: number } | null;
  /** Il blocco col nome della superficie, che sotto i 768 prende il suo posto. */
  titolo: { pl: number; daSx: number } | null;
  tabs: { h: number; sopra: number; sotto: number }[];
  comandi: Comando[];
}

/**
 * Una sola passata dentro la pagina che legge TUTTO quello che serve alle due
 * famiglie di test: la riga, la striscia (se c'è), le tab, il nome della
 * superficie (se c'è) e i comandi della riga. Una funzione sola perché il
 * conto sui bottoni deve essere lo stesso ai due lati del breakpoint —
 * duplicarlo è il modo in cui i due capi della stessa barra hanno finito per
 * avere due grammatiche, che è il difetto che questo file esiste per prendere.
 */
async function leggiRiga(page: Page): Promise<Riga> {
  return page.evaluate(() => {
    const arrotonda = (n: number) => Math.round(n * 10) / 10;
    const barra = document.querySelector(".pane-chrome-bar") as HTMLElement;
    const rb = barra.getBoundingClientRect();
    const strip = barra.querySelector("[class*='overflow-x-auto']") as HTMLElement | null;
    const titoloEl = barra.querySelector('[data-testid="mobile-pane-title"]') as HTMLElement | null;
    const rt = titoloEl?.getBoundingClientRect();
    return {
      barra: { h: arrotonda(rb.height) },
      strisce: barra.querySelectorAll("[class*='overflow-x-auto']").length,
      strip: strip
        ? {
            pl: parseFloat(getComputedStyle(strip).paddingLeft),
            pr: parseFloat(getComputedStyle(strip).paddingRight),
          }
        : null,
      titolo:
        titoloEl && rt
          ? {
              pl: parseFloat(getComputedStyle(titoloEl).paddingLeft),
              daSx: arrotonda(rt.left - rb.left),
            }
          : null,
      tabs: Array.from(barra.querySelectorAll("[data-pane-id]")).map((el) => {
        const r = el.getBoundingClientRect();
        return {
          h: arrotonda(r.height),
          sopra: arrotonda(r.top - rb.top),
          sotto: arrotonda(rb.bottom - r.bottom),
        };
      }),
      // I comandi della RIGA, non quelli dentro una tab (la X di chiusura vive
      // dentro `[data-pane-id]` e ha una misura sua, tarata sulla tab).
      comandi: Array.from(barra.querySelectorAll("button"))
        .filter((b) => b.getBoundingClientRect().width > 0 && !b.closest("[data-pane-id]"))
        .map((b) => {
          const r = b.getBoundingClientRect();
          return {
            titolo: b.getAttribute("title") || b.getAttribute("aria-label") || "?",
            w: arrotonda(r.width),
            h: arrotonda(r.height),
            sopra: arrotonda(r.top - rb.top),
            sotto: arrotonda(rb.bottom - r.bottom),
            daSx: arrotonda(r.left - rb.left),
            daDx: arrotonda(rb.right - r.right),
          };
        }),
    };
  });
}

/**
 * Aspetta che la riga abbia FINITO di ri-disporsi.
 *
 * Non un `waitForTimeout`: una misura presa a metà del riflusso è un numero
 * vero di uno stato che non esiste, e una pausa fissa non sa dire quando il
 * riflusso è finito — indovina. Qui si campiona la scatola finché due letture
 * consecutive non coincidono, che è la stessa condizione che Playwright usa
 * prima di un click.
 *
 * `?? null` e non un `!`: subito dopo un cambio di viewport `boundingBox()` può
 * tornare NULL per un istante. Non è un errore, è «non ancora» —
 * dereferenziandolo il poll ESPLODE invece di riprovare.
 */
async function attendiRigaFerma(page: Page, largMax: number): Promise<void> {
  const riga = page.locator(".pane-chrome-bar").first();
  let precedente = "";
  await expect
    .poll(
      async () => {
        const b = await riga.boundingBox().catch(() => null);
        if (!b || b.width > largMax) {
          precedente = "";
          return false;
        }
        const ora = `${b.x},${b.y},${b.width},${b.height}`;
        const fermo = ora === precedente;
        precedente = ora;
        return fermo;
      },
      { timeout: 15000 },
    )
    .toBe(true);
}

/** Apre le due chat a schermo largo e poi porta la finestra alla misura
 *  chiesta: sotto i 768px la colonna è un pannello sovrapposto e `openTopic`
 *  non arriverebbe alla riga. */
async function apriDueChat(page: Page, request: Parameters<typeof resetPaneStore>[0], w: number, h: number) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await resetPaneStore(request, ids);
  await goToApp(page);
  for (const n of nomi) await openTopic(page, n);
  await expect(page.locator(".pane-chrome-bar").first()).toBeVisible({ timeout: 15000 });
  await page.setViewportSize({ width: w, height: h });
  await attendiRigaFerma(page, w);
}

test.describe("Barra delle tab a 1280px", () => {
  let m: Riga;

  test.beforeEach(async ({ page, request }) => {
    await apriDueChat(page, request, 1280, 800);
    m = await leggiRiga(page);
    expect(m.tabs.length, "servono due tab per misurare i due capi").toBeGreaterThanOrEqual(2);
    expect(m.comandi.length, "nessun comando nella riga").toBeGreaterThanOrEqual(1);
    expect(m.strip, "la striscia delle tab non c'è").not.toBeNull();
  });

  test("ARIA-1: il comando e la tab hanno LA STESSA misura, quindi lo stesso respiro", async () => {
    // Il cuore della faccenda: il verticale non si sceglie — (40 − box)/2 —
    // quindi comando e tab respirano uguale solo se hanno lo stesso box sullo
    // stesso breakpoint. È il test che sarebbe stato rosso col predicato
    // disallineato, e verde con qualunque numero coerente nelle costanti.
    const attesa = (m.barra.h - BOX_MOUSE) / 2;
    for (const t of m.tabs) {
      expect(t.h, "altezza della tab").toBe(BOX_MOUSE);
      expect(t.sopra).toBe(attesa);
      expect(t.sotto).toBe(attesa);
    }
    for (const c of m.comandi) {
      expect(c.w, `larghezza di «${c.titolo}»`).toBe(BOX_MOUSE);
      expect(c.h, `altezza di «${c.titolo}»`).toBe(BOX_MOUSE);
      expect(c.sopra, `aria sopra «${c.titolo}»`).toBe(attesa);
      expect(c.sotto, `aria sotto «${c.titolo}»`).toBe(attesa);
    }
  });

  test("ARIA-2: ogni comando sta ROW_INSET dal suo bordo, e i due capi sono specchiati", async () => {
    // Era `chromeRowInset(box)`: col dito veniva 2, cioè il bottone incollato
    // al bordo mentre la strip senza comando si ferma a 6.
    for (const c of m.comandi) {
      const dalBordo = Math.min(c.daSx, c.daDx);
      expect(dalBordo, `«${c.titolo}» dal bordo più vicino`).toBe(ROW_INSET);
    }
  });

  test("ARIA-3: la strip si ferma ROW_INSET prima del comando, ai due capi", async () => {
    // La riserva è bordo + box + bordo. Il terzo pezzo è quello che mancava:
    // senza, la prima e l'ultima tab toccavano la scatola del bottone.
    expect(m.strip?.pr, "riserva a destra (il «+»)").toBe(riserva(BOX_MOUSE));
    expect(m.strip?.pl, "riserva a sinistra (riapri colonna)").toBe(riserva(BOX_MOUSE));
  });

  test("ARIA-4: a inizio scroll la prima tab non tocca il comando", async ({ page }) => {
    // La misura geometrica che ARIA-3 promette dal padding — presa dove
    // conta, cioè con la strip riportata a zero. `raised-control-overlay` fa
    // sì che scorrendo le tab passino SOTTO il bottone: è voluto, e per
    // questo il vincolo si legge a scroll fermo a inizio corsa.
    const varchi = await page.evaluate(() => {
      const barra = document.querySelector(".pane-chrome-bar") as HTMLElement;
      const strip = barra.querySelector("[class*='overflow-x-auto']") as HTMLElement;
      strip.scrollLeft = 0;
      const rb = barra.getBoundingClientRect();
      const tabs = Array.from(barra.querySelectorAll("[data-pane-id]"));
      const prima = tabs[0].getBoundingClientRect();
      return { sinistro: Math.round((prima.left - rb.left) * 10) / 10 };
    });
    expect(varchi.sinistro, "bordo → prima tab").toBe(riserva(BOX_MOUSE));
  });
});

test.describe("La riga della superficie a 390px", () => {
  let m: Riga;

  test.beforeEach(async ({ page, request }) => {
    await apriDueChat(page, request, 390, 844);
    m = await leggiRiga(page);
  });

  test("ARIA-TEL-1: niente striscia, al suo posto il nome della superficie", async () => {
    // La misura che regge tutte le altre: sotto i 768 la riga NON ha una
    // striscia scorrevole. Detto qui e una volta sola, invece di lasciare che
    // ogni altro test ci inciampi dentro con un locator vuoto.
    expect(m.strisce, "strisce scorrevoli nella riga").toBe(0);
    expect(m.titolo, "manca il nome della superficie").not.toBeNull();
  });

  test("ARIA-TEL-2: l'unico comando ha il box da DITO e lo stesso respiro", async () => {
    // Il «+» qui non c'è (il suo gemello sta nella fila in basso), quindi il
    // comando è uno: quello che riapre la colonna. Il box è quello da dito,
    // e il verticale resta derivato — (altezza riga − box) / 2.
    expect(m.comandi.length, "comandi nella riga").toBe(1);
    const c = m.comandi[0];
    const attesa = (m.barra.h - BOX_DITO) / 2;
    expect(c.w, `larghezza di «${c.titolo}»`).toBe(BOX_DITO);
    expect(c.h, `altezza di «${c.titolo}»`).toBe(BOX_DITO);
    expect(c.sopra, `aria sopra «${c.titolo}»`).toBe(attesa);
    expect(c.sotto, `aria sotto «${c.titolo}»`).toBe(attesa);
    expect(c.daSx, `«${c.titolo}» dal bordo sinistro`).toBe(ROW_INSET);
  });

  test("ARIA-TEL-3: la riga si svuota ma non si sposta", async () => {
    // Il nome parte dove partiva la striscia: stessa riserva, bordo + box +
    // bordo. È il contratto scritto accanto al ramo mobile di
    // `StandaloneChatGroup` — togliere le tab non doveva spostare niente.
    expect(m.titolo, "manca il nome della superficie").not.toBeNull();
    expect(m.titolo?.pl, "riserva a sinistra (riapri colonna)").toBe(riserva(BOX_DITO));
    // E il testo comincia DOPO il comando, non sotto: la riserva è un padding,
    // quindi il blocco parte a filo bordo e a contare è dove finisce l'incasso.
    const inizioTesto = (m.titolo?.daSx ?? 0) + (m.titolo?.pl ?? 0);
    expect(inizioTesto, "bordo → prima lettera del nome").toBeGreaterThanOrEqual(
      ROW_INSET + BOX_DITO,
    );
  });
});
