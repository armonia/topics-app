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
 * Ed è ora una misura onesta anche in Playwright senza `hasTouch`: da quando
 * l'altezza della tab è `h-9 md:h-7`, la larghezza decide tutto e una viewport
 * stretta prova davvero il ramo compatto.
 */
import { test, expect, type Page } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/** L'incasso della colonna: `ROW_INSET` in `lib/selectionStyles.ts`. */
const ROW_INSET = 6;

/** I due lati del breakpoint `md:` (768px), con il box che ciascuno impone. */
const SCHERMI = [
  { nome: "mouse", w: 1280, h: 800, box: 28 },
  { nome: "stretto", w: 390, h: 844, box: 36 },
];

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

interface Misura {
  barra: { h: number };
  strip: { pl: number; pr: number };
  tabs: { h: number; sopra: number; sotto: number }[];
  comandi: { titolo: string; w: number; h: number; sopra: number; sotto: number; daSx: number; daDx: number }[];
}

async function misura(page: Page): Promise<Misura> {
  return page.evaluate(() => {
    const barra = document.querySelector(".pane-chrome-bar") as HTMLElement;
    const rb = barra.getBoundingClientRect();
    const strip = barra.querySelector("[class*='overflow-x-auto']") as HTMLElement;
    const cs = getComputedStyle(strip);
    const arrotonda = (n: number) => Math.round(n * 10) / 10;
    return {
      barra: { h: arrotonda(rb.height) },
      strip: { pl: parseFloat(cs.paddingLeft), pr: parseFloat(cs.paddingRight) },
      tabs: Array.from(barra.querySelectorAll("[data-pane-id]")).map((el) => {
        const r = el.getBoundingClientRect();
        return { h: arrotonda(r.height), sopra: arrotonda(r.top - rb.top), sotto: arrotonda(rb.bottom - r.bottom) };
      }),
      // I comandi della RIGA, non quelli dentro una tab (la X di chiusura vive
      // dentro `[data-pane-id]` e ha una misura sua, tarata sulla tab).
      comandi: Array.from(barra.querySelectorAll("button"))
        .filter((b) => b.getBoundingClientRect().width > 0 && !b.closest("[data-pane-id]"))
        .map((b) => {
          const r = b.getBoundingClientRect();
          return {
            titolo: b.getAttribute("title") || b.getAttribute("aria-label") || "?",
            w: arrotonda(r.width), h: arrotonda(r.height),
            sopra: arrotonda(r.top - rb.top), sotto: arrotonda(rb.bottom - r.bottom),
            daSx: arrotonda(r.left - rb.left), daDx: arrotonda(rb.right - r.right),
          };
        }),
    };
  });
}

for (const s of SCHERMI) {
  test.describe(`Barra delle tab a ${s.w}px`, () => {
    let m: Misura;

    test.beforeEach(async ({ page, request }) => {
      // Si apre SEMPRE largo e poi si stringe: sotto i 768px la colonna è un
      // pannello sovrapposto e `openTopic` non arriva alla riga.
      await page.setViewportSize({ width: 1280, height: 800 });
      await resetPaneStore(request, ids);
      await goToApp(page);
      for (const n of nomi) await openTopic(page, n);
      await expect(page.locator(".pane-chrome-bar").first()).toBeVisible({ timeout: 15000 });
      await page.setViewportSize({ width: s.w, height: s.h });
      // Il layout deve essersi FERMATO prima di leggerlo: una misura presa a
      // metà del riflusso è un numero vero di uno stato che non esiste.
      await expect
        .poll(async () => (await page.locator(".pane-chrome-bar").first().boundingBox())!.width)
        .toBeLessThanOrEqual(s.w);
      await page.waitForTimeout(300);
      m = await misura(page);
      expect(m.tabs.length, "servono due tab per misurare i due capi").toBeGreaterThanOrEqual(2);
      expect(m.comandi.length, "nessun comando nella riga").toBeGreaterThanOrEqual(1);
    });

    test("ARIA-1: il comando e la tab hanno LA STESSA misura, quindi lo stesso respiro", async () => {
      // Il cuore della faccenda: il verticale non si sceglie — (40 − box)/2 —
      // quindi comando e tab respirano uguale solo se hanno lo stesso box sullo
      // stesso breakpoint. È il test che sarebbe stato rosso col predicato
      // disallineato, e verde con qualunque numero coerente nelle costanti.
      const attesa = (m.barra.h - s.box) / 2;
      for (const t of m.tabs) {
        expect(t.h, "altezza della tab").toBe(s.box);
        expect(t.sopra).toBe(attesa);
        expect(t.sotto).toBe(attesa);
      }
      for (const c of m.comandi) {
        expect(c.w, `larghezza di «${c.titolo}»`).toBe(s.box);
        expect(c.h, `altezza di «${c.titolo}»`).toBe(s.box);
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
      const attesa = ROW_INSET + s.box + ROW_INSET;
      expect(m.strip.pr, "riserva a destra (il «+»)").toBe(attesa);
      expect(m.strip.pl, "riserva a sinistra (riapri colonna)").toBe(attesa);
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
      expect(varchi.sinistro, "bordo → prima tab").toBe(ROW_INSET + s.box + ROW_INSET);
    });
  });
}
