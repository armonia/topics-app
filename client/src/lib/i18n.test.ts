/**
 * Due cose vanno provate, e nessuna delle due è «traduce»: che una chiave
 * mancante NON finisca a schermo, e che le due lingue restino allineate — una
 * lingua incompleta è un fatto da scoprire qui, non guardando l'interfaccia a
 * caso.
 */
import { describe, test, expect } from 'bun:test';
import { t, resolveLocale, interpolate, missingKeys, FALLBACK_LOCALE } from './i18n';

describe('resolveLocale', () => {
  test('una preferenza esplicita vince sempre', () => {
    expect(resolveLocale('en', 'it-IT')).toBe('en');
    expect(resolveLocale('it', 'en-US')).toBe('it');
  });

  test('auto segue il browser', () => {
    expect(resolveLocale('auto', 'en-GB')).toBe('en');
    expect(resolveLocale('auto', 'it-IT')).toBe('it');
  });

  test('senza preferenza e senza browser: italiano', () => {
    // È la lingua di questa casa, non un default universale.
    expect(resolveLocale(undefined, undefined)).toBe('it');
    expect(FALLBACK_LOCALE).toBe('it');
  });

  test('una lingua sconosciuta non diventa inglese per sbaglio', () => {
    expect(resolveLocale('auto', 'de-DE')).toBe('it');
  });
});

describe('t', () => {
  test('traduce nelle due lingue', () => {
    expect(t('board.night.title', 'it')).toBe('Modalità notturna');
    expect(t('board.night.title', 'en')).toBe('Night mode');
  });

  test('una chiave inesistente NON esplode e non inventa', () => {
    expect(t('non.esiste.proprio', 'it')).toBe('non.esiste.proprio');
  });

  test('interpola i valori', () => {
    expect(t('board.night.sessions.many', 'it', { n: 3 })).toBe('3 sessioni attive');
    expect(t('board.night.sessions.many', 'en', { n: 3 })).toBe('3 active sessions');
  });

  test('un segnaposto senza valore resta com’è invece di sparire', () => {
    // Un buco visibile si nota e si corregge; un testo mutilato in silenzio no.
    expect(interpolate('ciao {nome}', {})).toBe('ciao {nome}');
  });
});

describe('allineamento fra le lingue', () => {
  test("nessuna delle due lingue ha buchi rispetto all'altra", () => {
    // Se questo test diventa rosso, qualcuno ha aggiunto una chiave a una lingua
    // sola — ed è esattamente il momento in cui va saputo.
    expect(missingKeys('it')).toEqual([]);
    expect(missingKeys('en')).toEqual([]);
  });
});
