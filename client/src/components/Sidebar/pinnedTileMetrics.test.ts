/**
 * @covers LAYOUT-21
 */
import { describe, expect, test } from 'bun:test';
import { ROW_ACTION_BOX, ROW_H } from '../../lib/selectionStyles';
import {
  PINNED_TILE_ACTION_INSET_CLASS,
  PINNED_TILE_ACTION_INSET_PX,
  PINNED_TILE_ACTION_SLOT,
  PINNED_TILE_H,
  PINNED_TILE_PX,
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
