/**
 * One tab per pane identity in the tab bar: duplicates collapse, ids with no
 * pane in the store get no tab, and an unchanged order keeps its reference.
 *
 * @covers LAYOUT-02
 */
import { describe, test, expect } from 'bun:test';
import { reconcilePaneOrder, renamePromotedDrafts } from './paneOrderReconcile';

const PROJECT = 'project:%2FUsers%2Futente%2FProjects%2Ftopics-app';

describe('reconcilePaneOrder — una identità per pane', () => {
  test('OSSERVATO: ordine con lo stesso project id 3 volte, store lo tiene 1 → 1 tab', () => {
    // La striscia mostrava TRE "topics-app" mentre lo store (openIds) ne aveva UNO.
    // La sorgente delle 3 tab era l'ordine persistito, non lo store.
    const orderedIds = ['__board__', PROJECT, PROJECT, PROJECT];
    const openIds = ['__board__', PROJECT]; // ciò che lo store conosce davvero
    expect(reconcilePaneOrder(orderedIds, openIds)).toEqual(['__board__', PROJECT]);
  });

  test('duplicato adiacente collassato, ordine dei primi-occorsi preservato', () => {
    expect(reconcilePaneOrder(['a', 'a', 'b', 'a', 'c', 'b'], ['a', 'b', 'c'])).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  test('un id non nello store non ha tab (funzione pura dello stato)', () => {
    expect(reconcilePaneOrder(['a', 'ghost', 'b'], ['a', 'b'])).toEqual(['a', 'b']);
  });

  test('drop + dedup insieme', () => {
    expect(reconcilePaneOrder(['a', 'ghost', 'a', 'b'], ['a', 'b'])).toEqual(['a', 'b']);
  });

  test('nessun cambiamento → STESSO riferimento (short-circuit del render)', () => {
    const orderedIds = ['a', 'b', 'c'];
    const out = reconcilePaneOrder(orderedIds, ['a', 'b', 'c']);
    expect(out).toBe(orderedIds);
  });

  test('accetta un Set come openIds', () => {
    expect(reconcilePaneOrder(['a', 'a', 'b'], new Set(['a', 'b']))).toEqual(['a', 'b']);
  });

  test('lista vuota / store vuoto', () => {
    expect(reconcilePaneOrder([], ['a'])).toEqual([]);
    expect(reconcilePaneOrder(['a', 'a'], [])).toEqual([]);
  });
});

describe('renamePromotedDrafts', () => {
  const promotions = new Map([['draft:x', 't1']]);
  const promoted = (id: string) => promotions.get(id);

  test('puts the topic where its draft stood', () => {
    expect(renamePromotedDrafts(['a', 'draft:x', 'b'], ['a', 't1', 'b'], promoted)).toEqual(['a', 't1', 'b']);
  });

  test('returns the same array when no draft was promoted', () => {
    const order = ['a', 'b'];
    expect(renamePromotedDrafts(order, ['a', 'b'], promoted)).toBe(order);
  });

  test('leaves a draft that is still open alone', () => {
    const order = ['draft:x', 'a'];
    expect(renamePromotedDrafts(order, ['draft:x', 'a', 't1'], promoted)).toBe(order);
  });

  test('does not rename to a topic that is not open', () => {
    const order = ['draft:x', 'a'];
    expect(renamePromotedDrafts(order, ['a'], promoted)).toBe(order);
  });
});
