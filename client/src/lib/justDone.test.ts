import { describe, expect, test } from 'bun:test';
import { landedInDone, statusSnapshot } from './justDone';
import type { TaskStatus } from './board';

const t = (id: string, status: TaskStatus) => ({ id, status });

describe('landedInDone', () => {
  test('primo caricamento: niente lampeggia, la lista non è "arrivata"', () => {
    expect(landedInDone(null, [t('a', 'done'), t('b', 'done')])).toEqual([]);
  });

  test('review → done: è la transizione che conta', () => {
    const before = statusSnapshot([t('a', 'review'), t('b', 'todo')]);
    expect(landedInDone(before, [t('a', 'done'), t('b', 'todo')])).toEqual(['a']);
  });

  test('già in done e ferma: non rilampeggia a ogni refetch', () => {
    // Il refetch gira a ogni evento del board: senza questo, la colonna Done
    // sarebbe una discoteca.
    const before = statusSnapshot([t('a', 'done')]);
    expect(landedInDone(before, [t('a', 'done')])).toEqual([]);
  });

  test('card mai vista prima: non lampeggia', () => {
    // Cambio di board, filtro che la fa rientrare, deep link: la card compare
    // già chiusa, ma non è successo niente adesso.
    const before = statusSnapshot([t('a', 'todo')]);
    expect(landedInDone(before, [t('a', 'todo'), t('nuova', 'done')])).toEqual([]);
  });

  test('done → todo (riaperta) e poi di nuovo done: lampeggia solo al ritorno', () => {
    const chiusa = statusSnapshot([t('a', 'done')]);
    expect(landedInDone(chiusa, [t('a', 'todo')])).toEqual([]);
    const riaperta = statusSnapshot([t('a', 'todo')]);
    expect(landedInDone(riaperta, [t('a', 'done')])).toEqual(['a']);
  });

  test('più card chiuse insieme (una fanout, un altro device) → tutte', () => {
    const before = statusSnapshot([t('a', 'review'), t('b', 'in_progress'), t('c', 'done')]);
    expect(landedInDone(before, [t('a', 'done'), t('b', 'done'), t('c', 'done')])).toEqual(['a', 'b']);
  });
});
