/**
 * Chi tiene il proprio trascritto in memoria, e chi lo restituisce.
 *
 * Questi test proteggono le due metà del difetto. Da una parte lo SFRATTO deve
 * avvenire davvero — senza, il processo della UI arriva a 1844 MB con la curva
 * piatta, che è la firma della memoria presa e mai restituita. Dall'altra non
 * deve mai toccare una chat viva: sfrattare una sessione guardata svuota una
 * lista a schermo, sfrattarne una occupata BUTTA lavoro (i messaggi in memoria
 * sono più freschi di quelli sul server), e sfrattare troppo presto trasforma
 * ogni ritorno indietro in una fetch.
 *
 * @covers LEAK-01
 */
import { describe, expect, test } from 'bun:test';
import {
  MESSAGE_MIN_IDLE_MS,
  decideMessageResidency,
  type MessageSessionFacts,
} from './messageResidency';

const NOW = 1_000_000_000;
/** Abbastanza vecchia da aver superato la grazia. */
const IDLE = NOW - MESSAGE_MIN_IDLE_MS * 2;

function s(over: Partial<MessageSessionFacts> & { key: string }): MessageSessionFacts {
  return { watched: false, busy: false, messages: 10, lastTouchedAt: IDLE, ...over };
}

function decide(sessions: MessageSessionFacts[], over: Partial<Parameters<typeof decideMessageResidency>[0]> = {}) {
  return decideMessageResidency({
    sessions,
    now: NOW,
    budget: 2,
    maxIdleMessages: 100,
    minIdleMs: MESSAGE_MIN_IDLE_MS,
    ...over,
  });
}

describe('decideMessageResidency', () => {
  test('non sfratta MAI una sessione guardata, per quanto vecchia', () => {
    const out = decide([
      s({ key: 'a', watched: true, lastTouchedAt: 0, messages: 100_000 }),
      s({ key: 'b' }), s({ key: 'c' }), s({ key: 'd' }), s({ key: 'e' }),
    ]);
    expect(out.evict).not.toContain('a');
    expect(out.keep).toContain('a');
  });

  test('non sfratta una sessione occupata: in memoria e\' piu\' fresca che sul server', () => {
    const out = decide([
      s({ key: 'stream', busy: true, lastTouchedAt: 0 }),
      s({ key: 'b' }), s({ key: 'c' }), s({ key: 'd' }),
    ]);
    expect(out.evict).not.toContain('stream');
  });

  test('rispetta la grazia: chi e\' stato lasciato ora resta', () => {
    const out = decide([
      s({ key: 'fresca', lastTouchedAt: NOW - 1_000 }),
      s({ key: 'b' }), s({ key: 'c' }), s({ key: 'd' }),
    ]);
    expect(out.evict).not.toContain('fresca');
  });

  test('tiene le piu\' recenti e sfratta le piu\' vecchie, fino al budget', () => {
    const out = decide([
      s({ key: 'vecchia', lastTouchedAt: IDLE - 3_000 }),
      s({ key: 'media', lastTouchedAt: IDLE - 2_000 }),
      s({ key: 'recente', lastTouchedAt: IDLE - 1_000 }),
    ], { budget: 2 });
    expect(out.keep.sort()).toEqual(['media', 'recente']);
    expect(out.evict).toEqual(['vecchia']);
  });

  test('il tetto sui messaggi morde anche quando gli slot avanzano', () => {
    // Due sole sessioni, budget 5: passano per conteggio. Ma la seconda
    // sfonda il tetto sui messaggi complessivi, ed e' quella la dimensione
    // che dice il peso vero.
    const out = decide([
      s({ key: 'grossa1', messages: 90, lastTouchedAt: IDLE - 1_000 }),
      s({ key: 'grossa2', messages: 90, lastTouchedAt: IDLE - 2_000 }),
    ], { budget: 5, maxIdleMessages: 100 });
    expect(out.keep).toEqual(['grossa1']);
    expect(out.evict).toEqual(['grossa2']);
  });

  test('la piu\' recente fra le inattive passa anche se da sola sfonda il tetto', () => {
    // Altrimenti la chat grossa da cui sei appena uscito si ricaricherebbe
    // ogni singola volta che ci torni.
    const out = decide([s({ key: 'enorme', messages: 10_000 })], { maxIdleMessages: 100 });
    expect(out.keep).toEqual(['enorme']);
    expect(out.evict).toEqual([]);
  });

  test('non sfratta una sessione vuota: non c\'e\' niente da liberare', () => {
    const out = decide([
      s({ key: 'vuota', messages: 0, lastTouchedAt: 0 }),
      s({ key: 'a' }), s({ key: 'b' }), s({ key: 'c' }),
    ], { budget: 1 });
    expect(out.evict).not.toContain('vuota');
  });

  test('e\' deterministica a parita\' di istante', () => {
    const sessions = [s({ key: 'b' }), s({ key: 'a' }), s({ key: 'c' })];
    const out = decide(sessions, { budget: 1 });
    expect(out.keep).toEqual(['a']);
    expect(out.evict).toEqual(['b', 'c']);
    // Stesso input in ordine diverso, stesso esito.
    const reversed = decide([...sessions].reverse(), { budget: 1 });
    expect(reversed.keep).toEqual(out.keep);
    expect(reversed.evict.sort()).toEqual(out.evict.sort());
  });

  test('senza sessioni non sfratta niente', () => {
    expect(decide([])).toEqual({ keep: [], evict: [] });
  });
});
