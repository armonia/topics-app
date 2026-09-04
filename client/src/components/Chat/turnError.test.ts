import { describe, expect, test } from 'bun:test';
import { turnErrorOf, turnIsOnlyError, turnLooksUnanswered, interruptedTurnOf, TURN_CAUSE_KEY } from './turnError';
import { STOP_CAUSES } from '../../../../shared/ws-outbound';
import type { TurnEndCause } from '../../types';
import it from '../../lib/i18n-it';
import en from '../../lib/i18n-en';

/**
 * «Questo turno è finito male?» e «c'è SOLO l'errore?».
 *
 * Due domande diverse, e confonderle costa: la prima accende il cartello, la
 * seconda il bottone che RIMANDA il messaggio. Su un turno che ha risposto e poi
 * è inciampato, rimandare non ripara niente — ne fa un secondo, a pagamento.
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
 * «NESSUNA RISPOSTA» NON SI DICE A UN TURNO CHE STA RISPONDENDO.
 *
 * Il caso riportato il 19/08: messaggio inviato, finestra ricaricata, e la
 * scatola ambra «la connessione può essersi interrotta» compariva su un turno
 * che stava lavorando. Il banner leggeva solo la mappa `streaming` di `useChat`
 * — memoria di processo, azzerata da ogni reload — e ignorava il registro del
 * server (`GET /api/topics/streaming` → `hydratedStreamTopics`), che invece
 * sopravvive.
 *
 * Questi test tengono ferme entrambe le direzioni, e non sono simmetriche: un
 * banner mancante costa un'attesa, un banner di troppo invita a rimandare il
 * messaggio e a pagare un SECONDO turno mentre il primo è ancora in corso.
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
