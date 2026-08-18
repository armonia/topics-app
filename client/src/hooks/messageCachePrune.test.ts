import { describe, expect, test } from 'bun:test';
import { decideCachePrune } from './messageCachePrune';

/**
 * La cache dei messaggi aveva riempito il localStorage fino a superare la quota
 * (5.245.244 byte su 5.242.880, misurati il 2026-07-29), e con la quota piena
 * ogni `setItem` dell'app falliva — compresa la coda dei messaggi scritti e non
 * ancora consegnati, che infatti nel database non esisteva.
 *
 * Questa e' la decisione di cosa buttare. Vale i test che costa perche' sbagliare
 * il verso — tenere le grosse invece delle piccole — o sbagliare il filtro delle
 * chiavi significa perdere roba dell'utente.
 */
describe('decideCachePrune', () => {
  test('sotto budget non butta niente', () => {
    const e = [{ key: 'a', bytes: 100 }, { key: 'b', bytes: 200 }];
    expect(decideCachePrune(e, 1000)).toEqual([]);
  });

  test('tiene le piccole e butta le grosse', () => {
    // A parita' di budget si conservano PIU' conversazioni, e la voce enorme e'
    // anche quella che il server ricarica volentieri.
    const e = [
      { key: 'enorme', bytes: 2_400_000 },
      { key: 'media', bytes: 300_000 },
      { key: 'piccola', bytes: 50_000 },
    ];
    expect(decideCachePrune(e, 400_000)).toEqual(['enorme']);
  });

  test('butta quante ne servono, non una sola', () => {
    const e = [
      { key: 'g1', bytes: 900_000 },
      { key: 'g2', bytes: 900_000 },
      { key: 'g3', bytes: 900_000 },
      { key: 'p', bytes: 10_000 },
    ];
    expect(decideCachePrune(e, 500_000).sort()).toEqual(['g1', 'g2', 'g3']);
  });

  test('una voce piu' + 'grande del budget intero se ne va', () => {
    expect(decideCachePrune([{ key: 'x', bytes: 9_000_000 }], 2_000_000)).toEqual(['x']);
  });

  test('nessuna voce: nessun errore', () => {
    expect(decideCachePrune([], 2_000_000)).toEqual([]);
  });

  test("il budget si consuma davvero: due voci che insieme sforano", () => {
    const e = [{ key: 'a', bytes: 600_000 }, { key: 'b', bytes: 600_000 }];
    // La prima entra (600k <= 1M), la seconda no (600k > 400k rimasti).
    expect(decideCachePrune(e, 1_000_000)).toEqual(['b']);
  });
});
