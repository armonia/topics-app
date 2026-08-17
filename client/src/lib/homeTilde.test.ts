import { describe, test, expect } from 'bun:test';
import { homeTilde } from './homeTilde';

describe('homeTilde', () => {
  test('accorcia la home: è la parte uguale per tutti i progetti', () => {
    expect(homeTilde('/Users/tizio/Projects/topics-app')).toBe('~/Projects/topics-app');
    expect(homeTilde('/home/mario/src/app')).toBe('~/src/app');
  });

  test('la home nuda diventa ~, non ~/', () => {
    expect(homeTilde('/Users/tizio')).toBe('~');
  });

  test('quello che non è una home resta intero: meglio lungo che sbagliato', () => {
    expect(homeTilde('/opt/homebrew/bin')).toBe('/opt/homebrew/bin');
    expect(homeTilde('/Users')).toBe('/Users');
    expect(homeTilde('')).toBe('');
  });

  test('non morde a metà di un nome di cartella', () => {
    // `/Users/tizio-backup` NON è dentro la home di `tizio`.
    expect(homeTilde('/Users/tizio-backup/x')).toBe('~/x');
    // Quello sopra è corretto (l'utente è `tizio-backup`). Questo invece
    // verifica che il confine sia lo slash e non un prefisso qualsiasi:
    expect(homeTilde('/UsersFake/tizio/x')).toBe('/UsersFake/tizio/x');
  });
});
