/**
 * The voice announcement queue: dedup, drain order, rollup threshold.
 *
 * @covers VOICE-01
 */
import { describe, test, expect } from 'bun:test';
import {
  enqueueAnnouncement,
  removeAnnouncement,
  nextAnnouncement,
  announceText,
  rollupText,
  EMPTY_ANNOUNCE_QUEUE,
  ROLLUP_THRESHOLD,
  type AnnounceItem,
} from './announceQueue';

function item(taskId: string, title = `Task ${taskId}`): AnnounceItem {
  return { taskId, projectId: 'p1', title };
}

describe('enqueueAnnouncement', () => {
  test('lo stesso taskId non raddoppia, sostituisce', () => {
    const q1 = enqueueAnnouncement(EMPTY_ANNOUNCE_QUEUE, item('a', 'primo giro'));
    const q2 = enqueueAnnouncement(q1, item('a', 'secondo giro'));
    expect(q2.items).toHaveLength(1);
    expect(q2.items[0].title).toBe('secondo giro');
  });

  test('task diversi si accodano in ordine', () => {
    const q = enqueueAnnouncement(enqueueAnnouncement(EMPTY_ANNOUNCE_QUEUE, item('a')), item('b'));
    expect(q.items.map((i) => i.taskId)).toEqual(['a', 'b']);
  });
});

describe('removeAnnouncement', () => {
  test('toglie un item in coda senza toccare gli altri', () => {
    const q = enqueueAnnouncement(enqueueAnnouncement(EMPTY_ANNOUNCE_QUEUE, item('a')), item('b'));
    const after = removeAnnouncement(q, 'a');
    expect(after.items.map((i) => i.taskId)).toEqual(['b']);
  });

  test('un taskId assente non fa niente', () => {
    const q = enqueueAnnouncement(EMPTY_ANNOUNCE_QUEUE, item('a'));
    expect(removeAnnouncement(q, 'zzz')).toEqual(q);
  });
});

describe('nextAnnouncement', () => {
  test('coda vuota: nessun annuncio', () => {
    expect(nextAnnouncement(EMPTY_ANNOUNCE_QUEUE)).toEqual({ announcement: null, rest: EMPTY_ANNOUNCE_QUEUE });
  });

  test('sotto la soglia: un item alla volta, FIFO', () => {
    const q = enqueueAnnouncement(enqueueAnnouncement(EMPTY_ANNOUNCE_QUEUE, item('a')), item('b'));
    const { announcement, rest } = nextAnnouncement(q);
    expect(announcement).toEqual({ kind: 'single', item: item('a') });
    expect(rest.items.map((i) => i.taskId)).toEqual(['b']);
  });

  test('alla soglia: un riassunto che svuota tutta la coda', () => {
    let q = EMPTY_ANNOUNCE_QUEUE;
    for (let i = 0; i < ROLLUP_THRESHOLD; i++) q = enqueueAnnouncement(q, item(`t${i}`));
    const { announcement, rest } = nextAnnouncement(q);
    expect(announcement?.kind).toBe('rollup');
    expect(rest).toEqual(EMPTY_ANNOUNCE_QUEUE);
  });
});

describe('announceText / rollupText', () => {
  test('un item senza domanda pendente', () => {
    expect(announceText(item('a', 'fix login'))).toBe('Ready for review: fix login.');
  });

  test('un item CON domanda pendente la include', () => {
    expect(announceText({ ...item('a', 'fix login'), questionText: 'confermi il piano?' }))
      .toBe('Ready for review: fix login. confermi il piano?');
  });

  test('il riassunto nomina tutti i titoli', () => {
    const items = [item('a', 'uno'), item('b', 'due')];
    expect(rollupText(items)).toBe('2 tasks ready for review: uno, due.');
  });
});
