/**
 * @covers NOTIF-HIST-01
 */
import { describe, expect, test } from 'bun:test';
import { formatNotificationAge, mergeNotificationRow } from './history';
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
