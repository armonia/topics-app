import { describe, expect, test } from 'bun:test';
import { ROW_ACTION_BOX } from '../../lib/selectionStyles';
import {
  PINNED_TILE_ACTION_INSET,
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
function risolvi(classes: string, prop: 'h' | 'w'): { wide: number; compact: number } {
  let nuda: number | null = null;
  let md: number | null = null;
  let maxMd: number | null = null;
  for (const cls of classes.split(/\s+/).filter(Boolean)) {
    const m = /^(?:(md|max-md):)?([hw])-(\d+(?:\.\d+)?)$/.exec(cls);
    if (!m || m[2] !== prop) continue;
    const px = Number(m[3]) * STEP_PX;
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

  test("l'altezza è il trigger più due volte il rientro", () => {
    // È QUESTO che fa coincidere i tre spazi attorno al «+» — e ciò che l'E2E
    // TILE-20 misura sullo schermo. Qui costa un millisecondo invece di un giro
    // di browser, quindi si rompe subito e non a fine suite.
    for (const larghezza of ['wide', 'compact'] as const) {
      const { tile, action } = PINNED_TILE_PX[larghezza];
      expect(tile).toBe(action + 2 * PINNED_TILE_ACTION_INSET);
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

  test('il rientro è uno solo, e positivo', () => {
    // Un rientro a zero farebbe coincidere i tre spazi passando per il verso
    // sbagliato: bottone a filo della tessera, tre volte zero.
    expect(PINNED_TILE_ACTION_INSET).toBeGreaterThan(0);
  });
});
