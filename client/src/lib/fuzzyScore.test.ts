import { describe, expect, it } from 'bun:test';
import { fuzzyScore, rankPaths } from './fuzzyScore';

/**
 * I casi qui sotto non sono inventati: sono le query che l'audit del 2026-08-06
 * ha misurato contro l'albero vero di questo repo, dove il vecchio filtro senza
 * punteggio le sbagliava tutte.
 *
 * @covers CMD-01
 */

const TREE = [
  'client/src/state/pane/store.ts',
  'client/src/state/signals/store.ts',
  'client/src/state/projectFocus.ts',
  'client/src/components/Layout/PanelGrid.tsx',
  'client/src/lib/popoverStyles.ts',
  'server/services/known-project-dirs.ts',
  'server/routes/files.ts',
  'desktop-tauri/src-tauri/src/lib.rs',
];

describe('fuzzyScore', () => {
  it('è una sottosequenza, non una sottostringa', () => {
    expect(fuzzyScore('sts', 'store.ts').match).toBe(true);
    expect(fuzzyScore('zzz', 'store.ts').match).toBe(false);
  });

  it('i caratteri consecutivi valgono più di quelli sparsi', () => {
    const consecutivi = fuzzyScore('store', 'store.ts').score;
    const sparsi = fuzzyScore('store', 's-t-o-r-e.ts').score;
    expect(consecutivi).toBeGreaterThan(sparsi);
  });

  it('un confine di parola vale più di una lettera in mezzo', () => {
    expect(fuzzyScore('p', 'pane.ts').score).toBeGreaterThan(fuzzyScore('p', 'apex.ts').score);
  });

  it('query vuota: passa tutto, senza punteggio', () => {
    expect(fuzzyScore('', 'qualunque')).toEqual({ match: true, score: 0 });
  });
});

describe('rankPaths', () => {
  it('«store.ts» mette in cima i file che si chiamano davvero così', () => {
    // Il difetto misurato: 198 path matchavano, gli 11 veri esistevano nella
    // lista e NESSUNO entrava nelle 20 righe mostrate, perché il taglio
    // arrivava prima dell'ordinamento (che non c'era).
    const top = rankPaths(TREE, 'store.ts', 3);
    expect(top[0].endsWith('/store.ts')).toBe(true);
    expect(top[1].endsWith('/store.ts')).toBe(true);
  });

  it('a parità di punteggio vince il path più corto', () => {
    const top = rankPaths(['a/b/c/d/store.ts', 'a/store.ts'], 'store.ts', 2);
    expect(top[0]).toBe('a/store.ts');
  });

  it('il nome del file batte un match sparso sul path', () => {
    const top = rankPaths(TREE, 'files', 2);
    expect(top[0]).toBe('server/routes/files.ts');
  });

  it('taglia DOPO aver ordinato, non prima', () => {
    // Con `limit: 1` deve uscire il migliore, non il primo incontrato.
    const [best] = rankPaths(TREE, 'popover', 1);
    expect(best).toBe('client/src/lib/popoverStyles.ts');
  });

  it('nessun match = lista vuota, non una lista qualunque', () => {
    expect(rankPaths(TREE, 'qwxz', 10)).toEqual([]);
  });

  it('query vuota = i primi `limit`, senza riordinare', () => {
    expect(rankPaths(TREE, '  ', 2)).toEqual(TREE.slice(0, 2));
  });
});
