/**
 * The mode separated from the model name.
 *
 * These tests protect `splitModelId` itself, not the label it feeds into:
 * it must only peel a trailing `[1m]`, and leave every other id — Claude,
 * Codex, OpenAI — untouched. What happens to the peeled name downstream
 * (`friendlyModelLabel`) is a separate concern with its own coverage.
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
    // splitModelId only peels the mode suffix — it must return non-Claude
    // ids byte-for-byte, whatever `friendlyModelLabel` later does with them.
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
