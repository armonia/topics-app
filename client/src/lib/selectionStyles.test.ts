/**
 * @covers CHROME-METRIC-01
 */
import { describe, expect, test } from 'bun:test';
import {
  SIDEBAR_INDENT_STEP, CHROME_ROW_ACTION_INSET, CHROME_ROW_ACTION_RESERVE, CHROME_ROW_ACTION_RESERVE_LEFT, COLUMN_GAP, CARD_H, ROW_ACTION_BOX, ROW_GAP, ROW_H, ROW_INSET, ROW_PX, SECTION_CARD, TAB_GAP_CLASS, TAB_LABEL, TAB_LABEL_TYPE, sectionCard, sectionIsland, sidebarRowCard,
} from './selectionStyles';

/**
 * I NUMERI DELLA RIGA DI CHROME, RILETTI INVECE CHE RACCONTATI.
 *
 * `CHROME_ROW_ACTION_INSET` e compagni sono LETTERALI Tailwind, e devono
 * restarlo: Tailwind genera le utility leggendo i sorgenti come testo, quindi
 * un `right-[${n}px]` composto a runtime non produce nessuna regola e il
 * bottone finisce a `right: 0` senza che niente lo dica. Il prezzo del
 * letterale è che l'aritmetica che lo giustifica vive in un commento — e un
 * commento non diventa rosso.
 *
 * Questo file è il prezzo pagato: ricalcola l'incasso da `chromeRowInset` e lo
 * confronta con la stringa. Se qualcuno cambia l'altezza della riga, il box del
 * comando o uno dei letterali, i tre si separano QUI invece che sullo schermo
 * di Attilio — che è il difetto da cui questa tornata è partita: «la spaziatura
 * a destra dovrebbe essere uguale a quella che ha sopra e sotto», misurata
 * 5,5/5,5/6 col mouse e 1,5/1,5/6 col dito.
 */

/** La scala di Tailwind: `n` vale `n × 0.25rem`, cioè `n × 4px`. */
const STEP_PX = 4;

/**
 * Il valore che vince per una proprietà, sulle due larghezze.
 *
 * Legge sia le classi della scala (`w-7`) sia i valori arbitrari
 * (`right-[5.5px]`): sono le due forme in cui queste misure sono scritte, e
 * mescolarle è proprio ciò che rende facile perderne una di vista.
 */
function risolvi(classes: string, prop: string): { wide: number; compact: number } {
  let nuda: number | null = null;
  let md: number | null = null;
  let maxMd: number | null = null;
  for (const cls of classes.split(/\s+/).filter(Boolean)) {
    const m = new RegExp(`^(?:(md|max-md):)?${prop}-(?:\\[(\\d+(?:\\.\\d+)?)px\\]|(\\d+(?:\\.\\d+)?))$`).exec(cls);
    if (!m) continue;
    const px = m[2] !== undefined ? Number(m[2]) : Number(m[3]) * STEP_PX;
    if (m[1] === 'md') md = px;
    else if (m[1] === 'max-md') maxMd = px;
    else nuda = px;
  }
  const wide = md ?? nuda;
  const compact = maxMd ?? nuda;
  if (wide === null || compact === null) {
    throw new Error(`nessuna misura '${prop}-' leggibile in "${classes}"`);
  }
  return { wide, compact };
}

describe('la riga di chrome e il comando in coda', () => {

  test("l'incasso dal bordo è ROW_INSET, non il respiro verticale", () => {
    // Era `chromeRowInset(box)`: col dito veniva 2, cioè il bottone incollato
    // al bordo mentre la strip senza comando si ferma a 6. Il bordo è una
    // domanda ORIZZONTALE e ha già il suo numero.
    const dx = risolvi(CHROME_ROW_ACTION_INSET, 'right');
    expect(dx).toEqual({ wide: ROW_INSET, compact: ROW_INSET });
  });

  test('la riserva della strip è bordo + box + la stessa aria del bordo', () => {
    // I tre pezzi ci sono tutti: 6 dal bordo, il box, e altri 6 prima della
    // tab. Era `box + chromeRowInset(box)`, cioè senza il terzo: la strip
    // finiva ESATTAMENTE sul bordo del bottone e la tab lo toccava.
    const box = risolvi(ROW_ACTION_BOX, 'w');
    const pr = risolvi(CHROME_ROW_ACTION_RESERVE, 'pr');
    expect(pr.wide).toBe(ROW_INSET + box.wide + ROW_INSET);
    expect(pr.compact).toBe(ROW_INSET + box.compact + ROW_INSET);
  });

  test('la riserva a SINISTRA è la stessa, specchiata', () => {
    // Era un `paddingLeft: 30` in linea: fisso sui due breakpoint, quindi
    // sbagliato su almeno uno dei due. I due capi della strip ospitano bottoni
    // gemelli e devono riservare lo stesso spazio.
    expect(risolvi(CHROME_ROW_ACTION_RESERVE_LEFT, 'pl')).toEqual(
      risolvi(CHROME_ROW_ACTION_RESERVE, 'pr'),
    );
  });
});

/**
 * IL PASSO DELLA COLONNA, PER LO STESSO MOTIVO DI SOPRA.
 *
 * `COLUMN_GAP` è un numero, ma la metà che tocca alle card è scritta come
 * classe (`my-[3px]`) e deve restare un letterale — Tailwind legge il sorgente
 * come testo. L'altra metà la mette il contenitore che scorre
 * (`TopicTree`, `paddingBlock: COLUMN_GAP / 2`), che invece il numero lo
 * importa. Due metà della stessa distanza, di cui una sola segue la costante:
 * se qualcuno porta COLUMN_GAP a 8 e la classe resta 3, sopra la prima card
 * restano 7px mentre fra due card ne passano 6, ed è di nuovo il near-miss che
 * questo giro serviva a togliere.
 */
describe('il passo verticale della colonna', () => {
  test('il margine della card è mezzo COLUMN_GAP, e sta scritto nella classe', () => {
    const base = sidebarRowCard({});
    const my = /(?:^|\s)my-\[(\d+)px\]/.exec(base);
    expect(my).not.toBeNull();
    expect(Number(my![1])).toBe(COLUMN_GAP / 2);
  });

  // NIENTE «due card adiacenti distano COLUMN_GAP» QUI, e vale la pena dire
  // perché: c'era, e non poteva fallire.
  //
  // Faceva `my * 2 === COLUMN_GAP` su una stringa — cioè riscriveva 3+3=6 in un
  // altro modo — e si giustificava dicendo che i margini «NON collassano,
  // perché stanno in un contenitore che scorre, che è un contesto di
  // formattazione a sé». Sbagliato: un BFC impedisce ai margini dei FIGLI di
  // sfuggire al contenitore, non il collasso FRA FRATELLI. A schermo le righe
  // stavano a 3px (misurato: `3,3,3`) mentre questo test era verde.
  //
  // Una distanza renderizzata si misura dove viene renderizzata:
  // `tests/e2e/tab-coherence-mobile.spec.ts` (TAB-COERENZA-3) legge i rettangoli
  // di due righe adiacenti a 390×844. Qui resta solo ciò che è davvero
  // verificabile da una stringa: che la classe dichiari mezzo passo.

  test('il passo ORIZZONTALE è lo stesso, e lo dice la stessa costante', () => {
    // Fra due tab c'erano 2px (`gap-0.5`) e fra due card della colonna 6: non
    // due scelte, lo stesso numero prima e dopo una correzione applicata a
    // metà. «Normalizza spaziature e dimensioni in tutte le tab sia verticali
    // che orizzontali» (Attilio, 09/08). Questo test è ciò che impedisce alla
    // metà orizzontale di restare di nuovo indietro.
    expect(risolvi(TAB_GAP_CLASS, 'gap').wide).toBe(COLUMN_GAP);
    expect(risolvi(TAB_GAP_CLASS, 'gap').compact).toBe(COLUMN_GAP);
  });

  test('mezzo passo è un numero intero di pixel', () => {
    // Un COLUMN_GAP dispari darebbe mezzi pixel su entrambe le metà, e un bordo
    // a 2,5px si vede come una riga sfocata.
    expect(COLUMN_GAP % 2).toBe(0);
  });
});

describe('le due famiglie di altezza, e le tre misure interne', () => {
  test('ROW_H e CARD_H sono due, e non si sovrappongono', () => {
    // Due famiglie legittime — la riga porta una subline, la card compatta no —
    // ma DEVONO restare due: sei altezze diverse era lo stato di partenza.
    const riga = risolvi(ROW_H, 'h');
    const card = risolvi(CARD_H, 'h');
    expect(riga.compact).toBeGreaterThan(card.compact);
    expect(riga.wide).toBeGreaterThan(card.wide);
    // La riga regge il minimo di tap target di iOS sotto i 768px; la card
    // compatta no, e non deve fingere di sì (là il bersaglio lo allarga
    // `tap-expand-y`).
    expect(riga.compact).toBe(44);
  });

  test('a touch screen at md width keeps the 44px row', () => {
    expect(ROW_H.split(/\s+/)).toContain('coarse:h-11');
  });

  test("l'aria DENTRO una riga è una sola, e SECTION_CARD la usa", () => {
    // `SECTION_CARD` stava a `gap-1.5` mentre otto superfici su quattordici
    // usavano `gap-2`: la costante era in minoranza rispetto ai suoi clienti.
    expect(risolvi(ROW_GAP, 'gap')).toEqual({ wide: 8, compact: 8 });
    expect(SECTION_CARD).toContain(ROW_GAP);
    expect(SECTION_CARD).toContain(ROW_H);
    expect(SECTION_CARD).toContain(ROW_PX);
  });

  test("a section's header is as tall as a row, the touch floor included", () => {
    // 25/11: the island headers with the tabs' heights and spacings. They used
    // to take 28 with the mouse from CARD_H; facing the column's rows at 34,
    // the same column read as two measures.
    const heights = SECTION_CARD.split(/\s+/).filter((c) => /^(?:md:|coarse:)?h-/.test(c));
    expect(heights.join(' ')).toBe(ROW_H);
    expect(heights).toContain('coarse:h-11');
    // No margin of its own: the island carries the inset, a row's 6px.
    expect(SECTION_CARD).not.toMatch(/(?:^|\s)m-\d/);
  });

  test('no ground at rest: a closed section and a row that is not a tab paint nothing', () => {
    // 25/11: "if not active in some way, no background, as the tabs should
    // already do". A class that paints at rest starts with `bg-` or carries a
    // width variant of it (`max-md:bg-`); hover and dark variants are not rest.
    const atRest = (cls: string) => cls.split(/\s+/).filter((c) => /^(?:max-md:|md:)?bg-/.test(c));
    expect(atRest(sectionCard(false))).toEqual([]);
    expect(atRest(sectionIsland(false))).toEqual([]);
    expect(sectionIsland(false)).not.toContain('edge-lit');
    expect(atRest(sidebarRowCard({}))).toEqual([]);
    expect(atRest(sidebarRowCard({ tab: 'closed' }))).toEqual([]);
    // Open, the island is the card, with the open tabs' resting ground.
    expect(atRest(sectionIsland(true))).toEqual(['bg-black/[0.05]']);
    expect(sectionIsland(true)).toContain('edge-lit');
    // The pointer: a closed header lights its ink, an open one takes the rows' hover.
    expect(sectionCard(false)).not.toContain('hover:bg-');
    expect(sectionCard(true)).toContain('hover:bg-black/[0.05]');
  });

  test("l'aria DENTRO non è quella FRA: due domande, due numeri", () => {
    // Non è pignoleria: sono due assi diversi (dentro una card / fra due card) e
    // il difetto era che ognuno aveva TRE valori. Averli distinti — e diversi —
    // è il modo di accorgersi se qualcuno li fonde per sbaglio.
    expect(risolvi(ROW_GAP, 'gap').wide).toBe(8);
    expect(risolvi(TAB_GAP_CLASS, 'gap').wide).toBe(COLUMN_GAP);
    expect(risolvi(ROW_GAP, 'gap').wide).not.toBe(COLUMN_GAP);
  });

  test('TAB_LABEL è TAB_LABEL_TYPE più il colore, e non una seconda scala', () => {
    // I due assi vanno separati (chi calcola il proprio tono prende solo il
    // tipo), ma la scala deve restare UNA: `TAB_LABEL` che diverge da
    // `TAB_LABEL_TYPE` sarebbe esattamente la copia da cui veniamo.
    expect(TAB_LABEL.startsWith(TAB_LABEL_TYPE)).toBe(true);
    expect(TAB_LABEL_TYPE).not.toContain('text-app-text');
  });
});

/**
 * THE INDENT PER DEPTH SURVIVES THE GUTTER TRIM.
 *
 * Card 14c086a5 cut the constant air left of a sidebar name from 60px to 52 by
 * closing the two reserved columns (accordion, head glyph) by half a gap. The
 * indent per depth is a DIFFERENT number and a wanted difference: it is how the
 * tree reads as a tree, and it must not be collateral damage.
 *
 * These are assertions on the CONSTANTS, and they are the cheap half of the
 * guard: they cannot see a CSS that flattens the tree while the numbers stay
 * intact. The geometric half is measured in the live DOM by LABELGUTTER-02
 * (`tests/e2e/sidebar-label-gutter.spec.ts`), which seeds a project row with a
 * chat inside it and subtracts the two insets. That e2e used to skip on every
 * run against a flat world; since it seeds its own second depth, it runs.
 * @covers LAYOUT-30
 */
describe('the sidebar indent survives the gutter trim (LAYOUT-30)', () => {
  test('the indent step is alive and bigger than a hairline', () => {
    // Zero would flatten the tree; 1-2px would be indistinguishable from the
    // rounding of the trim that this card applied.
    expect(SIDEBAR_INDENT_STEP).toBeGreaterThan(4);
  });
});
