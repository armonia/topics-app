import { describe, expect, test } from 'bun:test';
import { landedInColumn, statusSnapshot } from './columnFlash';
import type { TaskStatus } from './board';

const t = (id: string, status: TaskStatus) => ({ id, status });
/** Le asserzioni si leggono meglio come coppie che come Map. */
const pairs = (m: Map<string, TaskStatus>) => [...m.entries()];

describe('landedInColumn', () => {
  test('primo caricamento: niente lampeggia, la lista non è "arrivata"', () => {
    expect(pairs(landedInColumn(null, [t('a', 'done'), t('b', 'done')]))).toEqual([]);
  });

  test('review → done: è la transizione che conta, e dice la colonna d\'arrivo', () => {
    const before = statusSnapshot([t('a', 'review'), t('b', 'todo')]);
    expect(pairs(landedInColumn(before, [t('a', 'done'), t('b', 'todo')]))).toEqual([['a', 'done']]);
  });

  test('ogni confine, non solo quello di Done', () => {
    // La regressione che questo modulo chiude: prima lampeggiava solo chi
    // arrivava in Done, e un task mandato in review o ripreso dal backlog si
    // spostava in silenzio.
    const before = statusSnapshot([t('a', 'in_progress'), t('b', 'backlog'), t('c', 'todo')]);
    expect(pairs(landedInColumn(before, [t('a', 'review'), t('b', 'todo'), t('c', 'in_progress')])))
      .toEqual([['a', 'review'], ['b', 'todo'], ['c', 'in_progress']]);
  });

  test('ferma nella sua colonna: non rilampeggia a ogni refetch', () => {
    // Il refetch gira a ogni evento del board: senza questo, la board sarebbe
    // una discoteca.
    const before = statusSnapshot([t('a', 'done'), t('b', 'todo')]);
    expect(pairs(landedInColumn(before, [t('a', 'done'), t('b', 'todo')]))).toEqual([]);
  });

  test('card mai vista prima: non lampeggia', () => {
    // Cambio di board, filtro che la fa rientrare, deep link: la card compare
    // già dov'è, ma non è successo niente adesso.
    const before = statusSnapshot([t('a', 'todo')]);
    expect(pairs(landedInColumn(before, [t('a', 'todo'), t('nuova', 'done')]))).toEqual([]);
  });

  test('done → todo (riaperta) e poi di nuovo done: lampeggia a ogni attraversata', () => {
    const chiusa = statusSnapshot([t('a', 'done')]);
    expect(pairs(landedInColumn(chiusa, [t('a', 'todo')]))).toEqual([['a', 'todo']]);
    const riaperta = statusSnapshot([t('a', 'todo')]);
    expect(pairs(landedInColumn(riaperta, [t('a', 'done')]))).toEqual([['a', 'done']]);
  });

  test('più card mosse insieme (una fanout, un altro device) → tutte', () => {
    const before = statusSnapshot([t('a', 'review'), t('b', 'in_progress'), t('c', 'done')]);
    expect(pairs(landedInColumn(before, [t('a', 'done'), t('b', 'done'), t('c', 'done')])))
      .toEqual([['a', 'done'], ['b', 'done']]);
  });
});
