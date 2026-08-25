import { test, expect, type Page } from "@playwright/test";
import { E2E_BASE } from "./helpers/test-server";
import { createTopic } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

/**
 * Nessuna lettera viene TAGLIATA dalla propria riga.
 *
 * `leading-none` fa una line box alta esattamente quanto il font-size, ma i
 * glifi vivono nella scatola del FONT — per la nostra pila ~1.21em — e ne
 * escono di ~0.105em sopra e altrettanto sotto. Da solo non si vedrebbe: a
 * tagliare è `overflow: hidden`, che `truncate` porta con sé per i puntini.
 * Misurato prima del rimedio: la riga sotto il nome di una chat perdeva 1.05px
 * in basso (le code di g/p/q) e il nome 0.93px in basso più 0.41px in alto su
 * una Ã. A schermo si legge come lettere mozzate sotto.
 *
 * Il difetto è INVISIBILE a un test che guarda le classi: `truncate` e
 * `leading-none` sono entrambe corrette, è la loro convivenza a tagliare. E
 * nemmeno uno screenshot lo prende in modo affidabile — è un pixel scarso su un
 * glifo. Quindi si MISURA: canvas `actualBoundingBox*` dà l'estensione reale
 * dell'inchiostro della stringa vera, la si posiziona rispetto alla baseline
 * calcolata dalla line box, e la si confronta con la scatola di ritaglio più
 * vicina (l'elemento stesso o il primo antenato che taglia).
 *
 * Il rimedio è l'utility `truncate-tight` (client/src/index.css): allarga il
 * padding box e restituisce lo stesso spazio con un margine negativo, così la
 * scatola di margine — e quindi il ritmo verticale — resta identica al pixel.
 */
hermetic(test);

/** Torna l'elenco dei testi il cui inchiostro esce dalla scatola che li taglia.
 *  Vuoto = nessuna lettera mozzata. */
const MISURA = `
(() => {
  const ctx = document.createElement('canvas').getContext('2d');
  const fuori = [];
  for (const el of document.querySelectorAll('*')) {
    const testo = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
    if (!testo) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue;

    // Chi taglia può essere l'elemento stesso o un antenato: si cerca la
    // scatola di ritaglio più vicina e si misura contro QUELLA.
    let clip = null;
    for (let hop = el; hop; hop = hop.parentElement) {
      const hs = hop === el ? cs : getComputedStyle(hop);
      if (['hidden', 'clip', 'auto', 'scroll'].includes(hs.overflowY)) {
        const hr = hop.getBoundingClientRect();
        clip = {
          top: hr.top + parseFloat(hs.borderTopWidth),
          bottom: hr.bottom - parseFloat(hs.borderBottomWidth),
          chi: hop === el ? 'se stesso' : hop.tagName.toLowerCase() + '.' + (hop.getAttribute('class') || '').slice(0, 40),
        };
        break;
      }
    }
    if (!clip) continue; // niente overflow sopra di lui: può sbordare quanto vuole

    ctx.font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + '/' + cs.lineHeight + ' ' + cs.fontFamily;
    const m = ctx.measureText(testo);
    const A = m.fontBoundingBoxAscent, D = m.fontBoundingBoxDescent;
    if (!isFinite(A) || !isFinite(D)) continue; // font non ancora pronto

    // Dove cade la baseline dentro la line box: mezzo interlinea + ascendente
    // del font (non della stringa: la line box la disegna lo "strut").
    const lh = cs.lineHeight === 'normal' ? (A + D) : parseFloat(cs.lineHeight);
    const baseline = (lh - (A + D)) / 2 + A;
    const cima = r.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop);
    const inkGiu = cima + baseline + m.actualBoundingBoxDescent;
    const inkSu = cima + baseline - m.actualBoundingBoxAscent;

    // Mezzo pixel di tolleranza: sotto non è inchiostro perso, è arrotondamento.
    const sotto = +(inkGiu - clip.bottom).toFixed(2);
    const sopra = +(clip.top - inkSu).toFixed(2);
    if (sotto <= 0.5 && sopra <= 0.5) continue;
    fuori.push({
      testo: testo.slice(0, 40), classi: (el.getAttribute('class') || '').slice(0, 90),
      fontSize: cs.fontSize, lineHeight: cs.lineHeight, taglia: clip.chi, sotto, sopra,
    });
  }
  return fuori.sort((a, b) => (b.sotto + b.sopra) - (a.sotto + a.sopra));
})()
`;

async function tagliati(page: Page): Promise<unknown[]> {
  return (await page.evaluate(MISURA)) as unknown[];
}

test.describe("Tipografia — nessuna lettera tagliata", () => {
  test("TYPO-1: le code e gli accenti stanno dentro la riga, in sidebar e nelle tessere", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "TYPO-01" });
    // Le due stringhe non sono decorative: `gg`/`ggi` scendono sotto la
    // baseline e `Ã` sale sopra le maiuscole. Un nome tutto minuscolo senza
    // discendenti non farebbe fallire il test nemmeno col difetto presente.
    const giu = await createTopic(page.request, "Progetto tipografia agg");
    const su = await createTopic(page.request, "Quaggiù passeggia già Ãgy");
    await page.request.put(`${E2E_BASE}/api/ui-state/sidebar-state`, {
      data: {
        viewMode: "timeline",
        showArchived: false,
        expandedNodes: [],
        pinnedItems: [`topic:${giu.id}`, `topic:${su.id}`],
        pinnedLayout: [{ keys: [`topic:${giu.id}`, `topic:${su.id}`], widths: [0.5, 0.5] }],
      },
    });

    await page.goto("/");
    await page.getByText("Quaggiù passeggia già Ãgy").first().waitFor({ timeout: 15_000 });
    await page.evaluate(() => document.fonts.ready);

    const inSidebar = await tagliati(page);
    expect(inSidebar, `testi tagliati in sidebar: ${JSON.stringify(inSidebar, null, 1)}`).toEqual([]);

    // Con una scheda aperta compaiono la barra delle tab e l'intestazione: sono
    // altre righe strette, e vanno misurate anche quelle.
    await page.getByText("Progetto tipografia agg").first().click();
    await page.waitForTimeout(800);
    const conScheda = await tagliati(page);
    expect(conScheda, `testi tagliati con una scheda aperta: ${JSON.stringify(conScheda, null, 1)}`).toEqual([]);
  });
});
