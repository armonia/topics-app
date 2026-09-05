/**
 * @covers NOTIF-HIST-01
 */
import { describe, expect, test } from 'bun:test';
import { formatNotificationAge, mergeNotificationPage, mergeNotificationRow } from './history';
import type { NotificationRow } from '../../../../shared/notification-log';

function row(id: string, createdAt = '2026-08-12T10:00:00.000Z'): NotificationRow {
  return {
    id,
    createdAt,
    kind: 'other',
    title: id,
    body: '',
    targetKind: null,
    targetId: null,
    targetUrl: null,
    source: 'banner',
    groupKey: null,
    seenAt: null,
  };
}

describe('mergeNotificationRow', () => {
  test('la riga nuova va in testa', () => {
    const merged = mergeNotificationRow([row('a')], row('b'));
    expect(merged.map((r) => r.id)).toEqual(['b', 'a']);
  });

  test('non duplica la riga che questa finestra ha appena scritto', () => {
    // Chi fa il POST riceve la stessa riga due volte: risposta HTTP e broadcast.
    const merged = mergeNotificationRow([row('a'), row('b')], row('a'));
    expect(merged.map((r) => r.id)).toEqual(['a', 'b']);
  });

  test("l'elenco in pagina ha un tetto", () => {
    const many = Array.from({ length: 5 }, (_, i) => row(`r${i}`));
    expect(mergeNotificationRow(many, row('nuova'), 3).length).toBe(3);
  });
});

describe('mergeNotificationPage', () => {
  test('una pagina vecchia si aggiunge in fondo, non sostituisce quella in mano', () => {
    const held = [row('b', '2026-08-12T10:00:02.000Z'), row('a', '2026-08-12T10:00:01.000Z')];
    const older = [row('z', '2026-08-12T09:00:00.000Z')];
    expect(mergeNotificationPage(held, older).map((r) => r.id)).toEqual(['b', 'a', 'z']);
  });

  test('la copia del server vince sulla stessa riga', () => {
    const held = [row('a')];
    const fromServer = { ...row('a'), seenAt: '2026-08-12T11:00:00.000Z' };
    expect(mergeNotificationPage(held, [fromServer])[0]!.seenAt).toBe('2026-08-12T11:00:00.000Z');
  });

  test('una riga arrivata dal vivo sopravvive alla rilettura', () => {
    // The defect itself: every open re-read the first page and wrote over the
    // list, dropping both the older pages asked for and the live rows.
    const live = [row('viva', '2026-08-12T10:00:09.000Z')];
    const page = [row('p1', '2026-08-12T10:00:05.000Z')];
    expect(mergeNotificationPage(live, page).map((r) => r.id)).toEqual(['viva', 'p1']);
  });

  test("l'elenco fuso ha un tetto", () => {
    const many = Array.from({ length: 6 }, (_, i) => row(`r${i}`, `2026-08-12T10:00:0${i}.000Z`));
    expect(mergeNotificationPage(many, [], 3).length).toBe(3);
  });
});

describe('formatNotificationAge', () => {
  const now = Date.parse('2026-08-12T12:00:00.000Z');
  test('scala da «adesso» ai giorni', () => {
    expect(formatNotificationAge('2026-08-12T11:59:30.000Z', now)).toBe('adesso');
    expect(formatNotificationAge('2026-08-12T11:50:00.000Z', now)).toBe('10 min');
    expect(formatNotificationAge('2026-08-12T09:00:00.000Z', now)).toBe('3 h');
    expect(formatNotificationAge('2026-08-11T12:00:00.000Z', now)).toBe('ieri');
    expect(formatNotificationAge('2026-08-09T12:00:00.000Z', now)).toBe('3 g');
  });

  test('una data illeggibile non stampa NaN', () => {
    expect(formatNotificationAge('non-una-data', now)).toBe('');
  });
});
