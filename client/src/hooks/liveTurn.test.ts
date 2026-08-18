import { describe, expect, test } from 'bun:test';
import { LIVE_TURN_MAX_SESSIONS, LiveTurnIds, liveAssistantIndex, shouldFillFromBroadcast } from './liveTurn';
import type { ChatMessage } from '../types';

/**
 * The pure half of `liveTurn`. The WIRING (which paths must call `end`, and the
 * fill actually landing in the transcript) is in `useChatLiveTurn.test.ts`,
 * which drives the real hook: a module that is right on its own proves nothing
 * about a caller that never calls it.
 */

function msg(p: Partial<ChatMessage>): ChatMessage {
  return { id: 'x', role: 'assistant', content: '', timestamp: '2026-08-15T00:00:00.000Z', ...p };
}

describe('LiveTurnIds', () => {
  test('ricorda e dimentica per sessione', () => {
    const r = new LiveTurnIds();
    r.begin('a', 'id-a');
    r.begin('b', 'id-b');
    expect(r.get('a')).toBe('id-a');
    r.end('a');
    expect(r.get('a')).toBeUndefined();
    expect(r.get('b')).toBe('id-b');
  });

  test('un turno nuovo sulla stessa sessione sostituisce il nome', () => {
    const r = new LiveTurnIds();
    r.begin('a', 'primo');
    r.begin('a', 'secondo');
    expect(r.get('a')).toBe('secondo');
    expect(r.size).toBe(1);
  });

  test('la mappa e LIMITATA: la pagina vive quanto la sessione del browser', () => {
    // Senza tetto questa mappa cresce con OGNI chat mai aperta e non cala mai:
    // `useChat` e una sola istanza per la vita della pagina.
    const r = new LiveTurnIds();
    for (let i = 0; i < LIVE_TURN_MAX_SESSIONS + 10; i++) r.begin(`s${i}`, `id${i}`);
    expect(r.size).toBe(LIVE_TURN_MAX_SESSIONS);
    expect(r.get('s0')).toBeUndefined();
    expect(r.get(`s${LIVE_TURN_MAX_SESSIONS + 9}`)).toBe(`id${LIVE_TURN_MAX_SESSIONS + 9}`);
  });

  test('lo sfratto e per ANZIANITA: chi ha appena iniziato un turno resta', () => {
    const r = new LiveTurnIds();
    for (let i = 0; i < LIVE_TURN_MAX_SESSIONS; i++) r.begin(`s${i}`, `id${i}`);
    // s0 e il piu vecchio; un turno nuovo lo riporta in cima.
    r.begin('s0', 'id0-bis');
    r.begin('nuova', 'id-nuova');
    expect(r.get('s0')).toBe('id0-bis');
    expect(r.get('s1')).toBeUndefined();
  });
});

describe('liveAssistantIndex', () => {
  const live = msg({ id: 'live', content: 'in volo', partial: true });
  const report = msg({ id: 'report', content: 'sotto-agente' });

  test('trova la bolla per nome anche se non e lultima', () => {
    expect(liveAssistantIndex([live, report], 'live')).toBe(0);
  });

  test('senza nome ricade sullultima, che e il comportamento SSE', () => {
    expect(liveAssistantIndex([live, report], undefined)).toBe(1);
  });

  test('un nome che non esiste piu ricade sullultima', () => {
    // E il caso del turno morto: se il nome NON viene dimenticato, questa
    // funzione lo cerca e lo trova nella bolla vecchia. Il ripiego vale solo
    // quando la riga non c'e proprio.
    expect(liveAssistantIndex([msg({ id: 'altro', content: 'x' })], 'live')).toBe(0);
  });

  test('un id che appartiene a un messaggio UTENTE non conta', () => {
    const utente = msg({ id: 'live', role: 'user', content: 'domanda' });
    expect(liveAssistantIndex([utente], 'live')).toBe(-1);
  });

  test('lista vuota o coda utente: nessuna bolla', () => {
    expect(liveAssistantIndex([], 'live')).toBe(-1);
    expect(liveAssistantIndex([msg({ role: 'user', content: 'ciao' })], undefined)).toBe(-1);
  });
});

describe('shouldFillFromBroadcast', () => {
  test('una bolla VUOTA si riempie', () => {
    expect(shouldFillFromBroadcast(msg({ content: '', partial: true }), 'la risposta')).toBe(true);
  });

  test('una bolla PARZIALE si completa', () => {
    expect(shouldFillFromBroadcast(msg({ content: 'la ris', partial: true }), 'la risposta')).toBe(true);
  });

  test('una anteprima piu CORTA non sovrascrive', () => {
    expect(shouldFillFromBroadcast(msg({ content: 'la risposta intera', partial: true }), 'la risposta')).toBe(false);
  });

  test('una riga gia finita non si tocca', () => {
    expect(shouldFillFromBroadcast(msg({ content: 'finita' }), 'finita e anche di piu')).toBe(false);
  });

  test('un messaggio utente non si tocca mai', () => {
    expect(shouldFillFromBroadcast(msg({ role: 'user', content: '' }), 'testo')).toBe(false);
  });

  test('niente da riempire se la riga non ce', () => {
    expect(shouldFillFromBroadcast(undefined, 'testo')).toBe(false);
  });
});
