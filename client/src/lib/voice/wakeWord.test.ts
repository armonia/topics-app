/**
 * The wake-word matcher: case/accent-insensitive, and what's left after it.
 */
import { describe, test, expect } from 'bun:test';
import { extractAfterWakePhrase, containsWakePhrase, DEFAULT_WAKE_PHRASE } from './wakeWord';

describe('extractAfterWakePhrase', () => {
  test('assente: null', () => {
    expect(extractAfterWakePhrase('approvo la consegna')).toBeNull();
  });

  test('presente da sola: resto vuoto', () => {
    expect(extractAfterWakePhrase(DEFAULT_WAKE_PHRASE)).toBe('');
  });

  test('presente con seguito: torna il testo dopo', () => {
    expect(extractAfterWakePhrase(`${DEFAULT_WAKE_PHRASE} approvo`)).toBe('approvo');
  });

  test('case e accenti non contano', () => {
    expect(extractAfterWakePhrase('HEY TOPICS approvo')).toBe('approvo');
  });

  test('una frase vuota per parola d\'attivazione: mai un match', () => {
    expect(extractAfterWakePhrase('qualunque cosa', '   ')).toBeNull();
  });
});

describe('containsWakePhrase', () => {
  test('rispecchia extractAfterWakePhrase', () => {
    expect(containsWakePhrase(`${DEFAULT_WAKE_PHRASE} ok`)).toBe(true);
    expect(containsWakePhrase('niente qui')).toBe(false);
  });
});
