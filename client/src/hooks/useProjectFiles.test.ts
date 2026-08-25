import { describe, expect, test } from 'bun:test';
import { desiredInterval, graftChildren, ROOT_DEPTH } from './useProjectFiles';
import type { FileNode } from '../types';

/**
 * Lo store dell'albero: le due decisioni che tolgono lo spinner e il rosso.
 *
 * I test toccano le parti PURE. Il resto dello store (fetch, sessionStorage,
 * `useSyncExternalStore`) è comportamento di browser e sta negli E2E:
 * `file-explorer-cache.spec.ts` prova il gesto vero — apri, chiudi, riapri —
 * che è la cosa che l'utente ha segnalato.
 *
 * @covers FILE-01
 */

const dir = (path: string, children?: FileNode[]): FileNode =>
  ({ name: path.split('/').pop()!, type: 'dir', path, children } as FileNode);
const file = (path: string): FileNode =>
  ({ name: path.split('/').pop()!, type: 'file', path } as FileNode);

describe('desiredInterval', () => {
  test('senza WS si chiede spesso, col WS si tiene solo una rete', () => {
    // Col push del watcher attivo il poll è una rete di sicurezza, non il
    // canale principale: chiedere ogni 30s sarebbe camminare l'albero per
    // niente.
    expect(desiredInterval({ wsChannels: 0, errorStreak: 0 })).toBe(30_000);
    expect(desiredInterval({ wsChannels: 1, errorStreak: 0 })).toBe(120_000);
  });

  test('il primo ritentativo è CORTO: 2s, non il passo normale', () => {
    // È la riga che copre la finestra di riavvio del server (3-5s): con un
    // backoff che parte da 30s si guarderebbe un pannello in errore per mezzo
    // minuto quando la risposta giusta era lì dopo due secondi.
    expect(desiredInterval({ wsChannels: 0, errorStreak: 1 })).toBe(2_000);
    expect(desiredInterval({ wsChannels: 0, errorStreak: 2 })).toBe(4_000);
    expect(desiredInterval({ wsChannels: 0, errorStreak: 3 })).toBe(8_000);
  });

  test('un guasto vero si dirada lo stesso, fino a un tetto', () => {
    expect(desiredInterval({ wsChannels: 0, errorStreak: 20 })).toBe(120_000);
  });

  test('in errore il WS non conta: si ritenta comunque presto', () => {
    // Se le richieste falliscono, il push probabilmente non arriva neanche.
    expect(desiredInterval({ wsChannels: 1, errorStreak: 1 })).toBe(2_000);
  });
});

describe('graftChildren', () => {
  const albero = [
    dir('/p/src', undefined),
    dir('/p/test', [file('/p/test/a.ts')]),
    file('/p/README.md'),
  ];

  test('innesta i figli nella cartella giusta', () => {
    const out = graftChildren(albero, '/p/src', [file('/p/src/x.ts')]);
    expect(out[0].children).toHaveLength(1);
    expect(out[0].children![0].path).toBe('/p/src/x.ts');
  });

  test('conserva l’IDENTITA dei rami che non cambiano', () => {
    // Non e' pignoleria: la versione ingenua ricrea ogni cartella CON figli
    // lungo tutto l'albero, non solo quelle sul cammino — quindi innestare una
    // cartella qualunque produceva un albero nuovo da cima a fondo, e ogni
    // `useMemo` a valle lo ricalcolava per niente.
    const out = graftChildren(albero, '/p/src', [file('/p/src/x.ts')]);
    expect(out[1]).toBe(albero[1]);
    expect(out[2]).toBe(albero[2]);
  });

  test('un innesto che non trova nulla restituisce l’albero STESSO', () => {
    expect(graftChildren(albero, '/p/inesistente', [file('/x')])).toBe(albero);
  });

  test('scende in profondità', () => {
    const profondo = [dir('/p/a', [dir('/p/a/b', undefined)])];
    const out = graftChildren(profondo, '/p/a/b', [file('/p/a/b/c.ts')]);
    expect(out[0].children![0].children![0].path).toBe('/p/a/b/c.ts');
  });

  test('una cartella che non c’è non rompe niente', () => {
    const out = graftChildren(albero, '/p/inesistente', [file('/x')]);
    expect(out).toHaveLength(3);
    expect(out[0].children).toBeUndefined();
  });

  test('sostituisce i figli invece di accodarli', () => {
    const out = graftChildren(albero, '/p/test', [file('/p/test/b.ts')]);
    expect(out[1].children).toHaveLength(1);
    expect(out[1].children![0].path).toBe('/p/test/b.ts');
  });
});

describe('profondità della radice', () => {
  test('è quella che il pannello chiedeva prima', () => {
    // Cambiarla cambia quanti sottoalberi arrivano gratis e quanti si comprano
    // uno per uno: non è un numero da toccare distrattamente.
    expect(ROOT_DEPTH).toBe(3);
  });
});
