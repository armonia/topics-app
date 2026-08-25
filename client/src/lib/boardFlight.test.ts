/**
 * Il viaggio della card, misurato senza un browser.
 *
 * Le tre cose che questo file tiene ferme, e sono le tre che si sbagliano:
 *  1. cambio di colonna = VIAGGIO (una copia che attraversa lo schermo),
 *     spostamento dentro la stessa colonna = SCIVOLATA (il nodo vero);
 *  2. SCORRERE NON E' MUOVERSI. Fra due render chi guarda scorre una colonna o
 *     la riga delle colonne: se le misure fossero quelle della finestra, ogni
 *     card risulterebbe spostata di quei pixel e si animerebbero tutte. E' lo
 *     stesso errore che faceva scattare i pinnati della sidebar, e qui e'
 *     escluso per costruzione (le posizioni sono DENTRO la colonna);
 *  3. una card NATA e una card appena trascinata non si animano: la prima non
 *     arriva da nessuna parte, la seconda e' gia' arrivata col dito.
 *
 * @covers KANBAN-01
 */
import { describe, test, expect } from 'bun:test';

import { planBoardMoves, type CardSpot, type ColumnBox } from './boardFlight';

const colonne = (over: Record<string, Partial<ColumnBox>> = {}): Map<string, ColumnBox> => {
  const base: Record<string, ColumnBox> = {
    todo: { left: 0, top: 100, scrollLeft: 0, scrollTop: 0 },
    in_progress: { left: 300, top: 100, scrollLeft: 0, scrollTop: 0 },
    review: { left: 600, top: 100, scrollLeft: 0, scrollTop: 0 },
  };
  for (const [k, v] of Object.entries(over)) base[k] = { ...base[k], ...v };
  return new Map(Object.entries(base));
};

const spot = (status: string, y: number, over: Partial<CardSpot> = {}): CardSpot =>
  ({ status, x: 0, y, w: 260, ...over });

describe('planBoardMoves', () => {
  test('cambio di colonna: un viaggio, con il delta fra le due posizioni', () => {
    const moves = planBoardMoves({
      before: new Map([['a', spot('todo', 0)]]),
      after: new Map([['a', spot('review', 40)]]),
      columns: colonne(),
    });
    expect(moves).toHaveLength(1);
    expect(moves[0].kind).toBe('flight');
    expect(moves[0].dx).toBe(-600);
    expect(moves[0].dy).toBe(-40);
  });

  test('una colonna piu\' larga: il viaggio porta anche il cambio di misura', () => {
    const moves = planBoardMoves({
      before: new Map([['a', spot('todo', 0, { w: 260 })]]),
      after: new Map([['a', spot('review', 0, { w: 520 })]]),
      columns: colonne(),
    });
    expect(moves[0].scale).toBeCloseTo(0.7, 5); // 260/520 = 0,5, limitato a 0,7
  });

  test('spostamento dentro la colonna: una scivolata, e la card che l\'ha causato viaggia', () => {
    const moves = planBoardMoves({
      before: new Map([['a', spot('todo', 0)], ['b', spot('review', 0)]]),
      // `a` va in review in cima, `b` scende per farle spazio.
      after: new Map([['a', spot('review', 0)], ['b', spot('review', 90)]]),
      columns: colonne(),
    });
    expect(moves.map((m) => `${m.id}:${m.kind}`)).toEqual(['a:flight', 'b:shift']);
    expect(moves[1].dy).toBe(-90);
  });

  test('scorrere una colonna non muove niente', () => {
    // Stessa posizione nel contenuto, colonna scorsa di 120px fra i due giri:
    // la card si vede 120px piu' su, ma non si e' spostata.
    const moves = planBoardMoves({
      before: new Map([['a', spot('todo', 400)]]),
      after: new Map([['a', spot('todo', 400)]]),
      columns: colonne({ todo: { scrollTop: 120 } }),
    });
    expect(moves).toEqual([]);
  });

  test('una card nata non arriva da nessuna parte', () => {
    const moves = planBoardMoves({
      before: new Map(),
      after: new Map([['a', spot('todo', 0)]]),
      columns: colonne(),
    });
    expect(moves).toEqual([]);
  });

  test('la card appena trascinata si salta', () => {
    const moves = planBoardMoves({
      before: new Map([['a', spot('todo', 0)]]),
      after: new Map([['a', spot('review', 0)]]),
      columns: colonne(),
      skip: new Set(['a']),
    });
    expect(moves).toEqual([]);
  });

  test('la colonna che si RIDIMENSIONA non e\' un riordino', () => {
    // Il drawer si apre, le colonne si stringono: le card cambiano larghezza e
    // posizione senza che nessuno abbia spostato niente.
    const moves = planBoardMoves({
      before: new Map([['a', spot('todo', 0, { w: 260 })]]),
      after: new Map([['a', spot('todo', 0, { x: 30, w: 200 })]]),
      columns: colonne(),
    });
    expect(moves).toEqual([]);
  });

  test('un movimento sub-pixel non e\' un movimento', () => {
    const moves = planBoardMoves({
      before: new Map([['a', spot('todo', 0)]]),
      after: new Map([['a', spot('todo', 0.4)]]),
      columns: colonne(),
    });
    expect(moves).toEqual([]);
  });

  test('mezza board che si rifa\' non diventa uno sciame di copie in volo', () => {
    const before = new Map<string, CardSpot>();
    const after = new Map<string, CardSpot>();
    for (let i = 0; i < 8; i++) {
      before.set(`t${i}`, spot('todo', i * 90));
      after.set(`t${i}`, spot('review', i * 90));
    }
    const moves = planBoardMoves({ before, after, columns: colonne() });
    expect(moves.filter((m) => m.kind === 'flight')).toHaveLength(3);
  });
});
