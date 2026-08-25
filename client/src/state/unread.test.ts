import { describe, test, expect } from 'bun:test';
import { applyUnreadUpdate, clearUnreadFor, hasUnread } from './unread';
import type { UnreadData } from '../types';

/**
 * Il contratto sotto test non è "il numero giusto" — è l'IDENTITÀ del valore di
 * ritorno. `unreadData` scende in tutto l'albero, quindi ogni oggetto nuovo è un
 * render globale: le asserzioni `toBe(prev)` sono la parte che conta davvero,
 * `toEqual` è il contorno.
 *
 * @covers TAB-BADGE-01, TAB-BADGE-02, TAB-BADGE-08
 */

const data = (counts: Record<string, number>): UnreadData =>
  Object.fromEntries(
    Object.entries(counts).map(([id, n]) => [id, { lastReadAt: '2026-01-01T00:00:00.000Z', unreadCount: n }]),
  );

describe('applyUnreadUpdate', () => {
  test('conteggio invariato → stesso oggetto, nessun render', () => {
    const prev = data({ a: 3, b: 0 });
    expect(applyUnreadUpdate(prev, 'a', 3)).toBe(prev);
    expect(applyUnreadUpdate(prev, 'b', 0)).toBe(prev);
  });

  test('topic mai vista con conteggio 0 → stesso oggetto', () => {
    // Il caso di gran lunga più frequente: il broadcast di un `unread:updated{0}`
    // per una topic che questo client non ha mai visto non letta.
    const prev = data({ a: 3 });
    expect(applyUnreadUpdate(prev, 'mai-vista', 0)).toBe(prev);
  });

  test('conteggio diverso → oggetto nuovo, valore aggiornato', () => {
    const prev = data({ a: 3 });
    const next = applyUnreadUpdate(prev, 'a', 5);
    expect(next).not.toBe(prev);
    expect(next.a.unreadCount).toBe(5);
    expect(prev.a.unreadCount).toBe(3); // niente mutazione in loco
  });

  test('conserva lastReadAt esistente e non tocca le altre topic', () => {
    const prev = data({ a: 1, b: 2 });
    const next = applyUnreadUpdate(prev, 'a', 7);
    expect(next.a.lastReadAt).toBe('2026-01-01T00:00:00.000Z');
    expect(next.b).toBe(prev.b);
  });

  test('topic nuova → entry creata con un lastReadAt valido', () => {
    const next = applyUnreadUpdate(data({}), 'nuova', 2);
    expect(next.nuova.unreadCount).toBe(2);
    expect(Number.isNaN(Date.parse(next.nuova.lastReadAt))).toBe(false);
  });
});

describe('clearUnreadFor', () => {
  test('già a zero o mai vista → stesso oggetto', () => {
    const prev = data({ a: 0 });
    expect(clearUnreadFor(prev, 'a')).toBe(prev);
    expect(clearUnreadFor(prev, 'assente')).toBe(prev);
  });

  test('non letti presenti → azzera solo quella topic', () => {
    const prev = data({ a: 4, b: 2 });
    const next = clearUnreadFor(prev, 'a');
    expect(next).not.toBe(prev);
    expect(next.a.unreadCount).toBe(0);
    expect(next.b).toBe(prev.b);
    expect(prev.a.unreadCount).toBe(4);
  });

  test('idempotente: la seconda passata non produce un oggetto nuovo', () => {
    const once = clearUnreadFor(data({ a: 4 }), 'a');
    expect(clearUnreadFor(once, 'a')).toBe(once);
  });
});

describe('hasUnread', () => {
  test('decide la POST di lettura: vero solo con conteggio > 0', () => {
    const d = data({ a: 1, b: 0 });
    expect(hasUnread(d, 'a')).toBe(true);
    expect(hasUnread(d, 'b')).toBe(false);
    expect(hasUnread(d, 'assente')).toBe(false);
  });

  test('va letto PRIMA di clearUnreadFor, altrimenti è sempre falso', () => {
    const prev = data({ a: 3 });
    expect(hasUnread(prev, 'a')).toBe(true);
    expect(hasUnread(clearUnreadFor(prev, 'a'), 'a')).toBe(false);
  });
});
