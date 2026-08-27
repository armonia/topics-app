/**
 * LO STACCO SOTTO L'HEADER DELLA COLONNA — misurato fra due cose DIPINTE.
 *
 * «Sotto la topbar della sidebar dove c'è il logo, sotto sembra esserci una
 * doppia spaziatura, derivante forse dal fatto che prima c'era il bordo sotto»
 * (Attilio, 08/08), ripetuto due volte il 09/08. La diagnosi era esatta e la
 * misura la conferma: fra il fondo dell'inchiostro dell'header e la prima card
 * passavano DODICI pixel dove fra due card ne passano SEI.
 *
 * Il punto delicato è che scatola-contro-scatola era già giusto — header 40,
 * prima card a 46: sei. A raddoppiare era lo spazio DIPINTO, perché l'header è
 * alto 40 attorno a un contenuto da 28 e porta quindi sei pixel suoi sotto il
 * proprio inchiostro. Un test sulle scatole sarebbe stato verde per tutti e tre
 * i giri in cui il difetto era visibile. Quindi qui si misura dal BOTTONE più
 * basso dell'header, non dalla sua scatola.
 *
 * Le due metà del difetto, entrambe coperte:
 *  · la lista aggiungeva il proprio mezzo passo anche in cima (`.sidebar-column`
 *    in index.css lo azzera per il primo elemento, qualunque esso sia);
 *  · sul telefono il titolo «Topics» era `min-h-7` in una riga da 56 mentre i
 *    suoi vicini sono 44, quindi il suo rialzo finiva 13px sopra il fondo della
 *    riga invece di 6.
  * @covers HDRGAP-01
 */
import { test, expect, type Page } from "@playwright/test";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

// Due righe, perché il passo di riferimento si misura fra due card adiacenti e
// senza semina la colonna ne ha una sola (la board).
const ids: string[] = [];

test.beforeAll(async ({ request }) => {
  const stamp = Date.now();
  for (let i = 0; i < 2; i++) {
    ids.push((await createTopic(request, `E2E-HeaderGap-${stamp}-${i}`)).id);
  }
});

test.afterAll(async ({ request }) => {
  for (const id of ids) await deleteTopic(request, id).catch(() => {});
});

/** `COLUMN_GAP` in `lib/selectionStyles.ts`: il passo della colonna. */
const COLUMN_GAP = 6;

const SCHERMI = [
  { nome: "mouse", w: 1280, h: 800 },
  { nome: "stretto", w: 390, h: 844 },
];

interface Misura {
  headerBox: { bottom: number };
  /** Il fondo del bottone dell'header che scende più in basso. */
  inchiostroHeader: number;
  /** La cima del primo elemento DIPINTO della colonna, e il suo nome. */
  primo: { top: number; cls: string };
  /** Lo stacco fra due elementi adiacenti della colonna, per confronto. */
  passi: number[];
}

async function misura(page: Page): Promise<Misura> {
  return page.evaluate(() => {
    const nav = document.querySelector('[aria-label="Topics sidebar"]')!;
    const header = nav.querySelector(".app-drag-region")!;
    const rh = header.getBoundingClientRect();
    // Il fondo dell'INCHIOSTRO: il bottone dell'header che arriva più in basso.
    // Sono il titolo e i due comandi, e devono stare tutti sulla stessa riga.
    const inchiostroHeader = Math.max(
      ...Array.from(header.querySelectorAll("button"))
        .filter((b) => b.getBoundingClientRect().height > 0)
        .map((b) => b.getBoundingClientRect().bottom),
    );
    const colonna = nav.querySelector(".sidebar-column")!;
    // Il primo elemento che DIPINGE qualcosa: le zone di spaziatura sono div
    // vuoti alti 0-6px e non contano — è proprio la loro somma il difetto.
    const dipinge = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.height >= 20 && r.width > 0;
    };
    const scendi = (el: Element): Element => {
      const primo = Array.from(el.children).find(dipinge);
      // Ci si ferma alla prima card: più giù ci sono glifi ed etichette, che
      // hanno una posizione loro dentro la card e non c'entrano con il ritmo.
      return primo && !dipinge(el) ? scendi(primo) : el;
    };
    const candidati = Array.from(colonna.children).filter(dipinge);
    const firstEl = candidati.length ? scendi(candidati[0]) : colonna.children[0];
    // Il passo di riferimento si prende fra due CARD, non fra due blocchi.
    //
    // Misurarlo fra i figli diretti della colonna darebbe 3: quei blocchi sono
    // eterogenei — la riga della board è una card col suo margine, la sezione
    // dei fissati è un contenitore che lo spazio se lo tiene DENTRO — e fra le
    // loro scatole passa mezzo passo mentre fra le cose dipinte ne passa uno
    // intero. Le card si riconoscono dal rientro laterale, che in questa
    // colonna ce l'hanno solo loro (`mx-1.5` = ROW_INSET in `sidebarRowCard`).
    const card = Array.from(colonna.querySelectorAll('[class*="mx-1.5"]')).filter(dipinge);
    const perParent = new Map<Element, Element[]>();
    for (const c of card) {
      if (!c.parentElement) continue;
      const lista = perParent.get(c.parentElement) ?? [];
      lista.push(c);
      perParent.set(c.parentElement, lista);
    }
    const fratelli = [...perParent.values()].find((v) => v.length >= 2) ?? [];
    const passi: number[] = [];
    for (let i = 1; i < Math.min(fratelli.length, 4); i++) {
      const a = fratelli[i - 1].getBoundingClientRect();
      const b = fratelli[i].getBoundingClientRect();
      passi.push(Math.round((b.top - a.bottom) * 10) / 10);
    }
    return {
      headerBox: { bottom: Math.round(rh.bottom * 10) / 10 },
      inchiostroHeader: Math.round(inchiostroHeader * 10) / 10,
      primo: {
        top: Math.round(firstEl.getBoundingClientRect().top * 10) / 10,
        cls: (firstEl.className || "").toString().slice(0, 80),
      },
      passi,
    };
  });
}

for (const s of SCHERMI) {
  test(`HEADER-GAP a ${s.w}px: sotto l'header c'è UN passo, non due`, async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "HDRGAP-01" });
    await page.setViewportSize({ width: s.w, height: s.h });
    await goToApp(page);
    await expect(page.locator(".sidebar-column").first()).toBeVisible({ timeout: 15000 });
    // Il layout deve essersi fermato: una misura presa a metà del riflusso è un
    // numero vero di uno stato che non esiste.
    await expect
      .poll(async () => (await misura(page)).primo.top, { timeout: 10000 })
      .toBeGreaterThan(0);
    const m = await misura(page);

    // 1. Lo stacco DIPINTO sotto l'header vale un passo, non due. È la misura
    //    che i tre giri precedenti non avevano.
    expect(
      m.primo.top - m.inchiostroHeader,
      `dal fondo dell'inchiostro dell'header (${m.inchiostroHeader}) alla prima card (${m.primo.top}) — «${m.primo.cls}»`,
    ).toBe(COLUMN_GAP);

    // 2. E vale lo STESSO passo che separa due card fra loro: il confronto è
    //    con quello che c'è a schermo, non con la costante, perché il difetto
    //    era proprio «qui il doppio di là».
    for (const p of m.passi) expect(p, "passo fra due elementi adiacenti").toBe(COLUMN_GAP);
    expect(m.passi.length, "servono almeno due elementi adiacenti").toBeGreaterThan(0);

    // 3. Tutti i comandi dell'header stanno sulla stessa riga: se il titolo
    //    fosse di nuovo più basso dei suoi vicini, (1) misurerebbe dal comando
    //    più alto e resterebbe verde mentre a schermo il titolo galleggia.
    const fondi = await page.evaluate(() => {
      const header = document.querySelector('[aria-label="Topics sidebar"] .app-drag-region')!;
      return Array.from(header.querySelectorAll("button"))
        .filter((b) => b.getBoundingClientRect().height > 0)
        .map((b) => Math.round(b.getBoundingClientRect().bottom * 10) / 10);
    });
    expect(new Set(fondi).size, `i comandi dell'header non sono allineati: ${fondi.join(", ")}`).toBe(1);
  });
}
