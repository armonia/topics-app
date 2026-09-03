/**
 * @covers LAYOUT-21
 */
import { describe, expect, test } from 'bun:test';
import { ROW_ACTION_BOX, ROW_CHEVRON, ROW_GAP, ROW_GLYPH_SLOT, ROW_H, ROW_PX } from '../../lib/selectionStyles';
import {
  PINNED_GRID_CHEVRON_CLASS,
  PINNED_GRID_CLEAR_CLASS,
  PINNED_GRID_PX,
  PINNED_TILE_ACTION_INSET_CLASS,
  PINNED_TILE_ACTION_INSET_PX,
  PINNED_TILE_ACTION_SLOT,
  PINNED_TILE_H,
  PINNED_TILE_PX,
  pinnedLabelRoom,
  pinnedLabelShown,
} from './pinnedTileMetrics';

/**
 * L'INVARIANTE DELLA TESSERA, riletta invece che raccontata.
 *
 * `pinnedTileMetrics.ts` dichiara da sempre che l'altezza di una tessera è
 * l'altezza del trigger più due volte il suo rientro — è quello che fa
 * coincidere i tre spazi attorno al «+» (sopra, a destra, sotto). Finora quella
 * frase viveva in un commento, e un commento non diventa rosso: il 07/08 il box
 * del comando è passato da 24 a 28 e il rientro è stato schiacciato da 4 a 2
 * per tenere ferma la tessera, cioè l'invariante ha retto per intervento
 * manuale. Qui la si riporta a essere una verifica.
 *
 * Si rileggono le CLASSI, non delle copie: la sorgente resta la stringa
 * Tailwind (Tailwind legge il sorgente, una composizione a runtime non
 * genererebbe nessuna regola), e il test è ciò che impedisce alla stringa e ai
 * numeri di divergere in silenzio.
 */

/** La scala di spaziatura di Tailwind: `n` vale `n × 0.25rem`, cioè `n × 4px`. */
const STEP_PX = 4;

/**
 * Il valore che vince per una proprietà, su ciascuna delle due larghezze.
 *
 * `md:` si applica sopra i 768px, `max-md:` sotto, la classe nuda dappertutto —
 * quindi «larga» è `md:` se c'è, altrimenti la nuda, e «stretta» è `max-md:` se
 * c'è, altrimenti la nuda. È esattamente la cascata che il browser applicherà,
 * scritta una volta invece di essere dedotta a occhio da chi legge la stringa.
 */
/* Legge anche i VALORI ARBITRARI (`h-[34px]`) e le proprietà di più di una
 * lettera (`px-`), che è la stessa forma del risolutore in
 * `selectionStyles.test.ts`. Prima accettava solo `[hw]-<numero>` della scala:
 * bastava che una misura passasse a un valore arbitrario — ed è successo il
 * giorno in cui la riga è diventata `md:h-[34px]` — perché il test morisse con
 * «nessuna misura leggibile» invece di dire che i due numeri non tornano.
 * Mescolare le due forme è proprio ciò che rende facile perderne una di vista. */
function risolvi(classes: string, prop: 'h' | 'w' | 'px' | 'right'): { wide: number; compact: number } {
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

describe('le misure della tessera fissata', () => {
  test('le classi dicono i pixel dichiarati', () => {
    const tessera = risolvi(PINNED_TILE_H, 'h');
    expect(tessera).toEqual({
      wide: PINNED_TILE_PX.wide.tile,
      compact: PINNED_TILE_PX.compact.tile,
    });

    // Il trigger è `ROW_ACTION_BOX`, cioè il box condiviso da OGNI comando in
    // coda a una riga della sidebar: se qualcuno lo muove di là, la tessera se
    // ne accorge di qua invece di scoprirlo con un bottone fuori centro.
    const box = risolvi(ROW_ACTION_BOX, 'h');
    expect(box).toEqual({
      wide: PINNED_TILE_PX.wide.action,
      compact: PINNED_TILE_PX.compact.action,
    });
    // Il box è quadrato: il rientro vale anche a destra solo se lo è.
    expect(risolvi(ROW_ACTION_BOX, 'w')).toEqual(box);
  });

  test('una tessera è alta quanto una riga, sui due rami', () => {
    // QUI C'ERA L'INVARIANTE «altezza = trigger + 2 × rientro», che teneva
    // insieme l'aria VERTICALE attorno al «+» e il suo rientro ORIZZONTALE. È
    // una regola che nessun'altra superficie dell'app segue — una riga della
    // colonna è alta 34 con un comando da 28 a 8px dal bordo, cioè 3 e 8 — e
    // decideva l'altezza della tessera a partire dal rientro del suo bottone.
    // Il risultato osservabile: 36 contro i 34 di una riga, nella stessa
    // colonna, con le due card una sopra l'altra.
    //
    // Adesso l'altezza è quella della riga, e basta. Le due misure restano
    // agganciate — se `ROW_H` cambia, la tessera lo segue — perché la costante è
    // la stessa, non una copia con lo stesso valore.
    expect(risolvi(PINNED_TILE_H, 'h')).toEqual(risolvi(ROW_H, 'h'));
  });

  test('il rientro del «+» è l\'aria che ha sopra e sotto', () => {
    // TRE SPAZI UGUALI attorno a un comando che flotta su una card — ed è il
    // verso a contare. L'aria verticale non si sceglie: la lascia il centraggio,
    // `(altezza − box) / 2`. Il rientro destro la COPIA. Prima il conto girava
    // al contrario (era il rientro a decidere l'altezza della tessera), e in
    // mezzo c'è stato un giro a `ROW_PX`: coerente con le righe, ma su una
    // tessera «il + ha più spazio a destra che sopra e sotto» — 8 contro 3.
    for (const larghezza of ['wide', 'compact'] as const) {
      const { tile, action } = PINNED_TILE_PX[larghezza];
      // Il tipo e' il LETTERALE (3 | 4), perche' l'oggetto e' `as const`, e
      // `toBe` pretenderebbe lo stesso letterale: qui si confrontano due misure
      // in pixel, non due costanti.
      const rientro: number = PINNED_TILE_ACTION_INSET_PX[larghezza];
      expect(rientro).toBe((tile - action) / 2);
    }
    // …e la CLASSE dice gli stessi due numeri: Tailwind legge il sorgente, quindi
    // la stringa è la sorgente e questi pixel sono solo la sua rilettura.
    expect(risolvi(PINNED_TILE_ACTION_INSET_CLASS, 'right')).toEqual({
      wide: PINNED_TILE_ACTION_INSET_PX.wide,
      compact: PINNED_TILE_ACTION_INSET_PX.compact,
    });
  });

  test("l'aria sopra e sotto il «+» non si sceglie: la lascia il centraggio", () => {
    // Non è più un terzo uso del rientro — è (altezza − box)/2. Si controlla che
    // sia un intero: un mezzo pixel sotto un bottone lo fa leggere fuori asse
    // rispetto ai vicini, ed è il difetto che questo file ha già pagato una
    // volta con un glifo da 13.
    for (const larghezza of ['wide', 'compact'] as const) {
      const { tile, action } = PINNED_TILE_PX[larghezza];
      const aria = (tile - action) / 2;
      expect(aria).toBeGreaterThan(0);
      expect(Number.isInteger(aria)).toBe(true);
    }
  });

  test('lo slot è largo quanto il comando che ci si appoggia', () => {
    // Uno slot più stretto del bottone lascerebbe il nome sotto il «+», che è
    // esattamente il difetto per cui lo slot esiste.
    const slot = risolvi(PINNED_TILE_ACTION_SLOT, 'w');
    expect(slot).toEqual({
      wide: PINNED_TILE_PX.wide.action,
      compact: PINNED_TILE_PX.compact.action,
    });
  });

  test('il rientro è positivo su entrambi i rami', () => {
    // Un rientro a zero farebbe coincidere i tre spazi passando per il verso
    // sbagliato: bottone a filo della tessera, tre volte zero.
    expect(PINNED_TILE_ACTION_INSET_PX.wide).toBeGreaterThan(0);
    expect(PINNED_TILE_ACTION_INSET_PX.compact).toBeGreaterThan(0);
  });
});

/** The pixels of a `gap-2` / `w-[18px]` / `left-2` class, on the bare (no
 *  breakpoint) variant only: the grid rule has one branch. */
function bare(classes: string, prop: 'gap' | 'w' | 'left'): number {
  for (const cls of classes.split(/\s+/).filter(Boolean)) {
    const m = new RegExp(`^${prop}-(?:\\[(\\d+)px\\]|(\\d+))$`).exec(cls);
    if (!m) continue;
    return m[1] !== undefined ? Number(m[1]) : Number(m[2]) * STEP_PX;
  }
  throw new Error(`no '${prop}-' measure readable in "${classes}"`);
}

/**
 * THE NAME OF A GRID TILE: drawn whole or not at all (card 058ea722, 03/09).
 *
 * The screenshot on the card: three tiles on a ~400px sidebar reading "to...",
 * "ar...", "ed...". The rule replaces a fixed 104px threshold with a measured
 * fit; here the fit is exercised on the numbers of that screenshot and on the
 * edges of the rule, without a browser.
 */
describe('the name of a grid tile', () => {
  test('the pixel budget is the classes the tile is drawn with, restated', () => {
    // Restating instead of importing is what lets Tailwind read the source;
    // this is what stops the restatement from drifting.
    expect<number>(PINNED_GRID_PX.inset).toBe(risolvi(ROW_PX, 'px').wide);
    expect(PINNED_GRID_PX.chevron).toBe(ROW_CHEVRON);
    expect<number>(PINNED_GRID_PX.gap).toBe(bare(ROW_GAP, 'gap'));
    expect<number>(PINNED_GRID_PX.icon).toBe(bare(ROW_GLYPH_SLOT, 'w'));
    // The width under which the hint leaves: two chevron zones and the icon.
    const { inset, chevron, gap, icon } = PINNED_GRID_PX;
    expect(PINNED_GRID_PX.chevronMin).toBeGreaterThanOrEqual((inset + chevron + gap) * 2 + icon);
  });

  test('the screenshot: a favicon tile at 130px does not show "to..." any more', () => {
    // 130 wide, opens (a project with tabs), favicon, "topics-app" at 13px is
    // ~65px. Room: 130 - 16 - 40 - 26 = 48. The name goes, the icon stays.
    const tile = { tileWidth: 130, hasIcon: true, expandable: true };
    expect(pinnedLabelRoom(tile)).toBe(48);
    expect(pinnedLabelShown({ ...tile, labelWidth: 65 })).toBe(false);
    // A short name in the same tile fits whole and is drawn.
    expect(pinnedLabelShown({ ...tile, labelWidth: 48 })).toBe(true);
    expect(pinnedLabelShown({ ...tile, labelWidth: 49 })).toBe(false);
  });

  test('without an accordion the chevron zone is not charged', () => {
    expect(pinnedLabelRoom({ tileWidth: 130, hasIcon: true, expandable: false })).toBe(88);
    // Under `chevronMin` the hint is not drawn, so its zone is free again.
    expect(pinnedLabelRoom({ tileWidth: 70, hasIcon: true, expandable: true })).toBe(70 - 16 - 26);
  });

  test('without an icon the name is the only identity: it stays, truncated if it must', () => {
    // A project without a favicon never shows a monogram in place of its
    // name; the name stays down to the width where one character exists.
    expect(pinnedLabelShown({ tileWidth: 60, labelWidth: 200, hasIcon: false, expandable: false })).toBe(true);
    expect(pinnedLabelShown({ tileWidth: 16 + PINNED_GRID_PX.glyphMin, labelWidth: 200, hasIcon: false, expandable: false })).toBe(true);
    expect(pinnedLabelShown({ tileWidth: 16 + PINNED_GRID_PX.glyphMin - 1, labelWidth: 200, hasIcon: false, expandable: false })).toBe(false);
  });

  test('in grid form the accordion is out of the flow, at the row inset', () => {
    // "When the icon is centred the accordion must stay on the left, where it
    // would be if nothing were centred": out of the flow, and at the same x
    // the row inset puts every other accordion of the column.
    expect(/(^|\s)absolute(\s|$)/.test(PINNED_GRID_CHEVRON_CLASS)).toBe(true);
    expect(bare(PINNED_GRID_CHEVRON_CLASS, 'left')).toBe(PINNED_GRID_PX.inset);
  });

  test('while the accordion is drawn the identity keeps its zone clear, on both sides', () => {
    // The padding the tile grows to is the same zone the fit rule charges:
    // inset + chevron + gap. Read from the class, at the width the hint
    // appears at, so the CSS and the arithmetic cannot drift apart.
    const { inset, chevron, gap, chevronMin } = PINNED_GRID_PX;
    const m = /^@min-\[(\d+)px\]\/tile:px-(\d+)$/.exec(PINNED_GRID_CLEAR_CLASS);
    expect(m, `unreadable clear class "${PINNED_GRID_CLEAR_CLASS}"`).not.toBeNull();
    expect(Number(m![1])).toBe(chevronMin);
    expect(Number(m![2]) * STEP_PX).toBe(inset + chevron + gap);
  });
});
