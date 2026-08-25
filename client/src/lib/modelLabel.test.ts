/**
 * La modalità separata dal nome del modello.
 *
 * Il caso che questi test proteggono è quello che ha rotto il picker: un id di
 * provider diverso da Claude non deve essere toccato. Il tentativo precedente
 * riusava `friendlyModelLabel`, che è claude-only, e `gpt-5.4-mini` diventava
 * «Gpt 5.4.mini» — un id che non esiste, mostrato sul controllo che dice quale
 * modello stai per usare.
 *
 * @covers CHAT-DEF-03
 */
import { describe, expect, test } from 'bun:test';
import { splitModelId } from './modelLabel';

describe('splitModelId', () => {
  test('un id senza modalità torna identico', () => {
    expect(splitModelId('claude-opus-5')).toEqual({ name: 'claude-opus-5', longContext: false });
  });

  test('stacca il suffisso [1m] dal nome', () => {
    expect(splitModelId('claude-opus-5[1m]')).toEqual({ name: 'claude-opus-5', longContext: true });
  });

  test('accetta il suffisso anche maiuscolo', () => {
    expect(splitModelId('claude-opus-5[1M]')).toEqual({ name: 'claude-opus-5', longContext: true });
  });

  test('NON tocca gli id degli altri provider', () => {
    // La ragione per cui questo modulo esiste invece di riusare
    // `friendlyModelLabel`: lì questo diventava «Gpt 5.4.mini».
    expect(splitModelId('gpt-5.4-mini')).toEqual({ name: 'gpt-5.4-mini', longContext: false });
    expect(splitModelId('o3')).toEqual({ name: 'o3', longContext: false });
  });

  test('il suffisso conta solo in CODA', () => {
    // Un `[1m]` in mezzo non è la modalità: toglierlo cambierebbe l'id.
    expect(splitModelId('foo[1m]-bar')).toEqual({ name: 'foo[1m]-bar', longContext: false });
  });

  test('una stringa vuota non esplode', () => {
    expect(splitModelId('')).toEqual({ name: '', longContext: false });
  });
});
