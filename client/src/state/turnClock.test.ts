import { describe, expect, test } from 'bun:test';
import { turnClock } from './turnClock';

describe('turnClock', () => {
  test('turno senza attese: il numero è il turno, e non c’è niente da spiegare', () => {
    const v = turnClock({ elapsedMs: 8_000, waitedMs: 0, waitingMs: null });
    expect(v.primaryMs).toBe(8_000);
    expect(v.workedMs).toBe(8_000);
    expect(v.totalWaitedMs).toBe(0);
    expect(v.title).toBeUndefined();
  });

  test('mentre aspetta: il numero è L’ATTESA, non il turno', () => {
    // Il caso che ha fatto storcere il naso: dieci minuti di turno di cui nove
    // e mezzo di pranzo. Il numero grande deve dire «da quanto aspetta te».
    const v = turnClock({ elapsedMs: 600_000, waitedMs: 0, waitingMs: 570_000 });
    expect(v.primaryMs).toBe(570_000);
    expect(v.workedMs).toBe(30_000);
    expect(v.title).toContain('in attesa di te');
    expect(v.title).toContain('lavorato');
  });

  test('a domanda chiusa il numero torna al LAVORO, con le attese sottratte', () => {
    const v = turnClock({ elapsedMs: 600_000, waitedMs: 570_000, waitingMs: null });
    expect(v.primaryMs).toBe(30_000);
    expect(v.workedMs).toBe(30_000);
    expect(v.totalWaitedMs).toBe(570_000);
    // Il totale grezzo non si perde: resta nella spiegazione.
    expect(v.title).toContain('turno aperto da');
  });

  test('più attese nello stesso turno si sommano, aperta compresa', () => {
    const v = turnClock({ elapsedMs: 100_000, waitedMs: 30_000, waitingMs: 20_000 });
    expect(v.totalWaitedMs).toBe(50_000);
    expect(v.workedMs).toBe(50_000);
    expect(v.primaryMs).toBe(20_000);
  });

  test('attesa più lunga del turno ⇒ lavoro a zero, mai negativo', () => {
    // I due cronometri non partono allo stesso tick: qualche millisecondo di
    // sfasatura non deve produrre un «lavorato -0.3s».
    const v = turnClock({ elapsedMs: 5_000, waitedMs: 0, waitingMs: 5_400 });
    expect(v.workedMs).toBe(0);
    expect(v.totalWaitedMs).toBe(5_000);
    expect(v.primaryMs).toBe(5_400);
  });

  test('numeri sporchi non producono numeri sporchi', () => {
    const v = turnClock({ elapsedMs: -10, waitedMs: -5, waitingMs: null });
    expect(v.primaryMs).toBe(0);
    expect(v.workedMs).toBe(0);
    expect(v.totalWaitedMs).toBe(0);
  });

  test('è pura: stesso input, stesso output', () => {
    const probe = { elapsedMs: 42_000, waitedMs: 1_000, waitingMs: null };
    expect(turnClock(probe)).toEqual(turnClock(probe));
  });
});
