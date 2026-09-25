import { describe, expect, test } from 'bun:test';
import { turnErrorOf, turnIsOnlyError, turnLooksUnanswered, interruptedTurnOf, liveInterruptionBlock, TURN_CAUSE_KEY } from './turnError';
import { STOP_CAUSES } from '../../../../shared/ws-outbound';
import type { ContentBlock, TurnEndCause } from '../../types';
import it from '../../lib/i18n-it';
import en from '../../lib/i18n-en';

/**
 * "Did this turn end badly?" and "is the error ALL there is?".
 *
 * Two different questions, and confusing them costs: the first lights the
 * banner, the second the button that RESENDS the message. On a turn that
 * answered and then stumbled, resending fixes nothing — it just runs a
 * second one, at a cost.
 *
 * @covers CHAT-REL-01
 */

const testo = (t: string) => ({ kind: 'text' as const, text: t });
const errore = (t: string) => ({ kind: 'error' as const, text: t });

describe('turnErrorOf — il verdetto', () => {
  test('il blocco error vince, ed è la forma nuova', () => {
    expect(turnErrorOf({ content: 'prosa vera', blocks: [testo('prosa vera'), errore('ack timeout')] }))
      .toBe('ack timeout');
  });

  test('senza errore, niente verdetto', () => {
    expect(turnErrorOf({ content: 'tutto bene', blocks: [testo('tutto bene')] })).toBeNull();
    expect(turnErrorOf({ content: '' })).toBeNull();
    expect(turnErrorOf({})).toBeNull();
  });

  test('le righe vecchie: il cartello sta nel testo, dietro il ⚠️', () => {
    expect(turnErrorOf({ content: '⚠️ Nessuna risposta: il turno si è chiuso.' }))
      .toBe('Nessuna risposta: il turno si è chiuso.');
  });

  test('di una riga vecchia si prende SOLO il primo capoverso', () => {
    // Una riadozione appende alla stessa colonna il contenuto rifuso. Prendere
    // tutto significherebbe stampare nel banner la stessa prosa che i blocchi
    // renderizzano già sotto — lo stesso testo, due volte.
    const c = '⚠️ Turno interrotto prima di una risposta finale.\n\nEcco invece cosa avevo fatto:\n- una cosa\n- un\'altra';
    expect(turnErrorOf({ content: c })).toBe('Turno interrotto prima di una risposta finale.');
  });

  test('un ⚠️ solo, senza frase, non è un verdetto', () => {
    expect(turnErrorOf({ content: '⚠️' })).toBeNull();
    expect(turnErrorOf({ content: '  ⚠️   ' })).toBeNull();
  });

  test('il ⚠️ a metà testo non è un cartello: è testo', () => {
    expect(turnErrorOf({ content: 'attenzione ⚠️ qui' })).toBeNull();
  });
});

describe('turnIsOnlyError — il cancello del bottone Riprova', () => {
  test('un turno di SOLO errore si può rimandare', () => {
    expect(turnIsOnlyError({ content: '⚠️ ack timeout' })).toBe(true);
    expect(turnIsOnlyError({ content: '', blocks: [errore('ack timeout')] })).toBe(true);
  });

  test('un turno che ha PRODOTTO non si rimanda', () => {
    // Il difetto: il cartello c'è, ma sotto c'è un turno intero. Un click
    // avrebbe rifatto da capo un lavoro già fatto.
    expect(turnIsOnlyError({ content: 'prosa', blocks: [testo('prosa'), errore('x')] })).toBe(false);
    expect(turnIsOnlyError({ content: '', blocks: [errore('x')], toolCalls: [{ id: 't1' }] })).toBe(false);
    expect(turnIsOnlyError({ content: '⚠️ Turno interrotto.\n\nAvevo già fatto questo.' })).toBe(false);
  });

  test('nessun errore, nessun bottone', () => {
    expect(turnIsOnlyError({ content: 'tutto bene' })).toBe(false);
  });
});

/**
 * "NO ANSWER" IS NOT SAID OF A TURN THAT IS STILL ANSWERING.
 *
 * The case reported on 19/08: message sent, window reloaded, and the amber
 * box "the connection may have dropped" showed up on a turn that was still
 * working. The banner only read `useChat`'s `streaming` map — process
 * memory, zeroed by every reload — and ignored the server's registry
 * (`GET /api/topics/streaming` → `hydratedStreamTopics`), which survives.
 *
 * These tests hold both directions steady, and they are not symmetric: a
 * missing banner costs a wait, an extra banner invites resending the
 * message and paying for a SECOND turn while the first is still in flight.
 */
describe('turnLooksUnanswered — il banner tace se qualcuno dice che il turno è vivo', () => {
  const caso = (p: Partial<Parameters<typeof turnLooksUnanswered>[0]>) =>
    turnLooksUnanswered({ lastMessageIsUser: true, locallyStreaming: false, serverSaysOpen: false, serverAsked: true, ...p });

  test('finché il server NON è stato interrogato il banner tace: un testimone assente non è un testimone contrario', () => {
    // On a reload the local map is empty AND the server's registry has not
    // answered yet (the GET leaves with the page): for ~300 ms both witnesses
    // are silent. Reading that as «nobody says it is alive» lit the amber box
    // above the composer and put it out a moment later: 51 px of composer
    // shrinking under the conversation (measured 2026-09-03).
    expect(caso({ serverAsked: false })).toBe(false);
    expect(caso({ serverAsked: false, serverSaysOpen: true })).toBe(false);
  });

  test('turno davvero senza risposta: il banner si mostra', () => {
    expect(caso({})).toBe(true);
  });

  test('È IL DIFETTO: dopo un reload la sessione locale è muta ma il SERVER dice che il turno è aperto', () => {
    // La riga che vale tutto il resto. `locallyStreaming` è false perché il
    // reload ha azzerato la mappa di processo; senza il secondo testimone il
    // banner accusava la rete di un turno perfettamente vivo.
    expect(caso({ locallyStreaming: false, serverSaysOpen: true })).toBe(false);
  });

  test('la sessione locale che streamma basta da sola (nessun poll ancora arrivato)', () => {
    // Il poll gira ogni 15 s: nei primi istanti di un turno appena inviato il
    // server può non essere ancora stato interrogato. La testimonianza locale
    // regge il caso, ed è la ragione per cui ne servono DUE e non una.
    expect(caso({ locallyStreaming: true, serverSaysOpen: false })).toBe(false);
  });

  test("se l'ultimo messaggio non è dell'utente non c'è nessuna attesa da dichiarare", () => {
    expect(caso({ lastMessageIsUser: false })).toBe(false);
    expect(caso({ lastMessageIsUser: false, serverSaysOpen: true })).toBe(false);
  });
});

/**
 * THE INTERRUPTED-TURN BANNER: what lights it, and what must leave it dark.
 *
 * Getting it wrong costs differently on each side. A missing banner on a dead
 * turn is waiting for an answer that never comes (the 2026-09-03 report); an
 * extra banner on a stop pressed by hand tells whoever just stopped the turn
 * that something broke.
 */
describe('interruptedTurnOf — chi accende il banner', () => {
  const killedTurn = (cause: TurnEndCause) => ({ blocks: [testo('a metà'), { kind: 'error' as const, text: 'timed out', cause, at: '2026-09-03T22:25:00.000Z' }] });

  test('il watchdog accende, con causa e istante', () => {
    expect(interruptedTurnOf(killedTurn('watchdog'))).toEqual({ cause: 'watchdog', text: 'timed out', at: '2026-09-03T22:25:00.000Z' });
  });

  test('lo stop della persona no: quel caso ha già il suo banner', () => {
    expect(interruptedTurnOf(killedTurn('user'))).toBeNull();
  });

  test('una riga senza causa no: assente vuol dire «non attribuito»', () => {
    expect(interruptedTurnOf({ blocks: [errore('ack timeout')] })).toBeNull();
  });

  /**
   * THE REFUSAL REPORTED 21/09 on topic:a5c4a915.
   *
   * The model said no, the server wrote the verdict, and the chat looked
   * "stuck with no feedback". The card was there: it was the 19th block of
   * 19, behind a pile of tool calls, where nobody scrolls. It didn't light up
   * because `refusal` was not a `StopCause` and the block went out without a
   * `cause` — and this banner only renders blocks that carry one.
   *
   * The row below is the EXACT shape the turn had: the final verdict, after
   * the work already produced.
   */
  test('un rifiuto accende: e\' l\'unico segnale che si vede senza scorrere', () => {
    const refused = {
      blocks: [
        testo('Verifico invece di rispondere a memoria'),
        { kind: 'error' as const, text: 'Richiesta rifiutata dal modello: violative cyber content', cause: 'refusal' as const, at: '2026-09-21T18:29:44.000Z' },
      ],
    };
    expect(interruptedTurnOf(refused)).toEqual({
      cause: 'refusal',
      text: 'Richiesta rifiutata dal modello: violative cyber content',
      at: '2026-09-21T18:29:44.000Z',
    });
  });

  test('un turno sano no', () => {
    expect(interruptedTurnOf({ blocks: [testo('tutto bene')] })).toBeNull();
    expect(interruptedTurnOf({})).toBeNull();
  });

  test('ogni causa ha la sua frase: nessun nome in codice stampato in faccia', () => {
    for (const cause of STOP_CAUSES) {
      const key = TURN_CAUSE_KEY[cause];
      expect(typeof key).toBe('string');
      expect(it[key as keyof typeof it]).toBeString();
      expect(en[key as keyof typeof en]).toBeString();
    }
  });
});

/**
 * THE LIVE PATH: the watchdog fires while somebody is watching.
 *
 * The row in the DB gets its verdict from the server, but the page holds that
 * message in memory and `stream:end` used to leave the bubble untouched: the
 * banner appeared on the next reload, that is, not to the person who was there.
 */
describe('liveInterruptionBlock - the verdict built from stream:end', () => {
  test('a watchdog end becomes the same block the server persisted', () => {
    const block = liveInterruptionBlock({ stopCause: 'watchdog', error: '⚠️ Response timed out.' });
    expect(block?.kind).toBe('error');
    expect(block).toMatchObject({ cause: 'watchdog', text: 'Response timed out.' });
    expect((block as { at?: string }).at).toBeTruthy();
  });

  test('an end with only the cause still explains itself: the banner renders the cause', () => {
    // The reaper's `stream:end` carries no sentence at all.
    expect(liveInterruptionBlock({ stopCause: 'watchdog' })).toMatchObject({ cause: 'watchdog', text: '' });
  });

  test('a clean end writes nothing', () => {
    expect(liveInterruptionBlock({})).toBeNull();
    expect(liveInterruptionBlock({ stopCause: undefined })).toBeNull();
  });

  test('a stop the machine wanted draws no banner, live or from the cache', () => {
    // A land, a delegation's deadline, the stall judge: the server persists no
    // notice and its `stream:end` carries no cause (routes/chat.ts, and the
    // abort route's own end). The row keeps only its tools, closed «Fermato».
    const row = [{ kind: 'tool' as const, toolCall: { id: 't1', name: 'Bash', status: 'error', error: 'Fermato: il lavoro della card è già atterrato o è passato altrove' } }] as ContentBlock[];
    const end = { stopReason: 'cancelled' } as { stopCause?: string; error?: string };
    expect(liveInterruptionBlock({ stopCause: end.stopCause, error: end.error, blocks: row })).toBeNull();
    expect(interruptedTurnOf({ blocks: row })).toBeNull();
    expect(turnErrorOf({ content: '', blocks: row })).toBeNull();
  });

  test('a stop by hand writes nothing: it has its own banner', () => {
    expect(liveInterruptionBlock({ stopCause: 'user' })).toBeNull();
  });

  test('a cause we cannot render is not printed as a code name', () => {
    expect(liveInterruptionBlock({ stopCause: 'something-new-nobody-translated' })).toBeNull();
  });

  test('a row already explained keeps its explanation, not two verdicts', () => {
    expect(liveInterruptionBlock({ stopCause: 'watchdog', blocks: [errore('già spiegato')] })).toBeNull();
  });

  test('what it builds is what the banner reads back', () => {
    // The round trip is the point: live and after a reload must agree.
    const block = liveInterruptionBlock({ stopCause: 'process-died', error: 'morto' });
    expect(interruptedTurnOf({ blocks: [testo('a metà'), block as ContentBlock] }))
      .toMatchObject({ cause: 'process-died' });
  });
});
