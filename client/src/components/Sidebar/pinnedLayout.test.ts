import { describe, expect, test } from 'bun:test';
import {
  PINNED_ROW_SOFT_MAX,
  deriveFromPinOrder,
  flattenPinnedLayout,
  insertPinnedRow,
  movePinnedTile,
  previewWidths,
  reconcilePinnedLayout,
  samePinnedLayout,
  tilesPerVisualRow,
  type PinnedRow,
} from './pinnedLayout';

/** Ogni riga deve sempre uscire con larghezze coerenti: una per chiave, somma 1. */
function expectWellFormed(layout: readonly PinnedRow[]) {
  for (const row of layout) {
    expect(row.widths.length).toBe(row.keys.length);
    expect(row.keys.length).toBeGreaterThan(0);
    const sum = row.widths.reduce((s, w) => s + w, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
  }
}

const row = (...keys: string[]): PinnedRow => ({
  keys,
  widths: keys.map(() => 1 / keys.length),
});

describe('deriveFromPinOrder', () => {
  test('spezza in righe da perRow, nell\'ordine di pin', () => {
    const l = deriveFromPinOrder(['a', 'b', 'c', 'd', 'e'], 2);
    expect(l.map(r => r.keys)).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
    expectWellFormed(l);
  });

  test('nessun fissato → nessuna riga', () => {
    expect(deriveFromPinOrder([], 4)).toEqual([]);
  });

  test('perRow degenere non manda in loop né perde chiavi', () => {
    expect(flattenPinnedLayout(deriveFromPinOrder(['a', 'b'], 0))).toEqual(['a', 'b']);
    expect(flattenPinnedLayout(deriveFromPinOrder(['a', 'b'], -3))).toEqual(['a', 'b']);
  });
});

describe('reconcilePinnedLayout', () => {
  test('layout assente → derivato dall\'ordine di pin', () => {
    const l = reconcilePinnedLayout(['a', 'b'], undefined);
    expect(flattenPinnedLayout(l)).toEqual(['a', 'b']);
    expectWellFormed(l);
  });

  test('pota le chiavi non più fissate e tiene le proporzioni delle superstiti', () => {
    const before: PinnedRow[] = [{ keys: ['a', 'b', 'c'], widths: [0.2, 0.3, 0.5] }];
    const l = reconcilePinnedLayout(['a', 'c'], before);
    expect(l.map(r => r.keys)).toEqual([['a', 'c']]);
    // 0.2 : 0.5 conservato come rapporto, non appiattito a 1/2.
    expect(l[0].widths[0]).toBeCloseTo(0.2 / 0.7, 9);
    expect(l[0].widths[1]).toBeCloseTo(0.5 / 0.7, 9);
    expectWellFormed(l);
  });

  test('una riga che si svuota sparisce', () => {
    const l = reconcilePinnedLayout(['a'], [row('a'), row('b')]);
    expect(l.map(r => r.keys)).toEqual([['a']]);
  });

  test('i doppioni collassano sulla prima occorrenza', () => {
    const l = reconcilePinnedLayout(['a', 'b'], [row('a', 'b'), row('a')]);
    expect(flattenPinnedLayout(l)).toEqual(['a', 'b']);
    expectWellFormed(l);
  });

  test('un fissato nuovo si accoda all\'ultima riga finché c\'è posto', () => {
    const l = reconcilePinnedLayout(['a', 'b', 'c'], [row('a', 'b')]);
    expect(l.map(r => r.keys)).toEqual([['a', 'b', 'c']]);
    expectWellFormed(l);
  });

  test('oltre il tetto per riga il fissato nuovo apre una riga', () => {
    const full = Array.from({ length: PINNED_ROW_SOFT_MAX }, (_, i) => `k${i}`);
    const l = reconcilePinnedLayout([...full, 'nuovo'], [row(...full)]);
    expect(l.length).toBe(2);
    expect(l[1].keys).toEqual(['nuovo']);
    expectWellFormed(l);
  });

  test('è idempotente', () => {
    const once = reconcilePinnedLayout(['a', 'b', 'c'], [row('a'), row('b', 'c')]);
    const twice = reconcilePinnedLayout(['a', 'b', 'c'], once);
    expect(samePinnedLayout(once, twice)).toBe(true);
  });

  test('regge righe malformate senza perdere i fissati', () => {
    const junk = [
      null,
      { keys: ['a'], widths: [] },
      { keys: 'nope', widths: [] },
      { keys: ['b', 42], widths: [0.5, 0.5] },
    ] as unknown as PinnedRow[];
    const l = reconcilePinnedLayout(['a', 'b', 'c'], junk);
    expect(flattenPinnedLayout(l).sort()).toEqual(['a', 'b', 'c']);
    expectWellFormed(l);
  });
});

describe('movePinnedTile', () => {
  test('sposta dentro la stessa riga, all\'indice chiesto', () => {
    const l = movePinnedTile([row('a', 'b', 'c')], 'c', { rowIdx: 0, insertAt: 0 });
    expect(l[0].keys).toEqual(['c', 'a', 'b']);
    expectWellFormed(l);
  });

  test('sposta su un\'altra riga', () => {
    const l = movePinnedTile([row('a', 'b'), row('c', 'd')], 'a', { rowIdx: 1, insertAt: 1 });
    expect(l.map(r => r.keys)).toEqual([['b'], ['c', 'a', 'd']]);
    expectWellFormed(l);
  });

  test('la riga di partenza che si svuota sparisce, e la destinazione scala', () => {
    // 'x' è solo sulla riga 0; destinazione riga 1 (che dopo la rimozione è la 0).
    const l = movePinnedTile([row('x'), row('a', 'b')], 'x', { rowIdx: 1, insertAt: 2 });
    expect(l.map(r => r.keys)).toEqual([['a', 'b', 'x']]);
    expectWellFormed(l);
  });

  test('indici fuori scala vengono clampati invece di rompere', () => {
    const l = movePinnedTile([row('a', 'b'), row('c')], 'a', { rowIdx: 99, insertAt: 99 });
    expect(flattenPinnedLayout(l).sort()).toEqual(['a', 'b', 'c']);
    expectWellFormed(l);
  });

  test('una chiave che non c\'è lascia il layout com\'è', () => {
    const before = [row('a', 'b')];
    const l = movePinnedTile(before, 'zzz', { rowIdx: 0, insertAt: 0 });
    expect(samePinnedLayout(before, l)).toBe(true);
  });

  test('non perde né duplica mai chiavi', () => {
    let l: PinnedRow[] = [row('a', 'b', 'c'), row('d', 'e')];
    const moves: Array<[string, number, number]> = [
      ['a', 1, 0], ['e', 0, 2], ['c', 1, 1], ['b', 0, 0], ['d', 1, 0],
    ];
    for (const [key, rowIdx, insertAt] of moves) {
      l = movePinnedTile(l, key, { rowIdx, insertAt });
      expect(flattenPinnedLayout(l).slice().sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
      expectWellFormed(l);
    }
  });
});

describe('insertPinnedRow', () => {
  test('apre una riga nuova in fondo', () => {
    const l = insertPinnedRow([row('a', 'b')], 'b', 1);
    expect(l.map(r => r.keys)).toEqual([['a'], ['b']]);
    expectWellFormed(l);
  });

  test('apre una riga nuova in mezzo', () => {
    const l = insertPinnedRow([row('a', 'b'), row('c')], 'a', 1);
    expect(l.map(r => r.keys)).toEqual([['b'], ['a'], ['c']]);
    expectWellFormed(l);
  });

  test('spostare l\'unica tessera di una riga su una riga nuova adiacente è un no-op', () => {
    const before = [row('x'), row('a')];
    expect(samePinnedLayout(insertPinnedRow(before, 'x', 0), before)).toBe(true);
    expect(samePinnedLayout(insertPinnedRow(before, 'x', 1), before)).toBe(true);
  });
});

describe('previewWidths', () => {
  test('è esattamente ciò che il drop produrrà', () => {
    const r = row('a', 'b');
    const preview = previewWidths(r, 1);
    const dropped = movePinnedTile([r, row('z')], 'z', { rowIdx: 0, insertAt: 1 });
    expect(preview.length).toBe(3);
    preview.forEach((w, i) => expect(w).toBeCloseTo(dropped[0].widths[i], 9));
  });

  test('somma 1 a ogni posizione d\'inserimento', () => {
    const r: PinnedRow = { keys: ['a', 'b', 'c'], widths: [0.5, 0.3, 0.2] };
    for (let at = 0; at <= 3; at++) {
      const w = previewWidths(r, at);
      expect(w.length).toBe(4);
      expect(Math.abs(w.reduce((s, x) => s + x, 0) - 1)).toBeLessThan(1e-9);
    }
  });
});

describe('tilesPerVisualRow', () => {
  test('sotto la larghezza minima la riga si spezza', () => {
    // 200px, gap 6, minimo 40 → (200+6)/(40+6) = 4 tessere
    expect(tilesPerVisualRow(200, 6, 6)).toBe(4);
  });

  test('con spazio a sufficienza tiene tutte le tessere della riga', () => {
    expect(tilesPerVisualRow(1000, 6, 5)).toBe(5);
  });

  test('non scende mai sotto una tessera per riga', () => {
    expect(tilesPerVisualRow(10, 6, 5)).toBe(1);
    expect(tilesPerVisualRow(0, 6, 1)).toBe(1);
  });
});
