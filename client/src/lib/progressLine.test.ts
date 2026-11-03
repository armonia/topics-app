import { describe, expect, test } from 'bun:test';
import { progressSentence } from './progressLine';

describe('progressSentence: the card in progress shows the last sentence', () => {
  test('takes the last sentence of a multi-sentence word', () => {
    expect(progressSentence('Ho letto il codice. Sto scrivendo il test. Quasi finito.')).toBe('Quasi finito.');
  });

  test('a single sentence is returned whole', () => {
    expect(progressSentence('Parto dalla card.')).toBe('Parto dalla card.');
  });

  test('markdown and line breaks are flattened to one line', () => {
    expect(progressSentence('**Piano**\n- primo passo\n- secondo passo')).toBe('Piano primo passo secondo passo');
  });

  test('an empty word yields an empty line', () => {
    expect(progressSentence('   ')).toBe('');
  });
});
