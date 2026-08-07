import { describe, expect, test } from 'bun:test';
import { turnErrorOf, turnIsOnlyError } from './turnError';

/**
 * «Questo turno è finito male?» e «c'è SOLO l'errore?».
 *
 * Due domande diverse, e confonderle costa: la prima accende il cartello, la
 * seconda il bottone che RIMANDA il messaggio. Su un turno che ha risposto e poi
 * è inciampato, rimandare non ripara niente — ne fa un secondo, a pagamento.
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
