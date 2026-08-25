/**
 * La tabella delle finestre e come si legge.
 *
 * `contextWindowFor` era già coperta da `server/usage/context-window.test.ts`,
 * che continua a girare sul modulo del server (ora un ri-export): quei test
 * restano dove sono, e coprono la stessa funzione da dove la usa il server.
 * Qui si guarda ciò che è nato con lo spostamento — il FORMATO — più le due
 * proprietà da cui dipende il picker adesso che mostra un numero per ogni
 * modello: che un modello sconosciuto non menta, e che `[1m]` valga più della
 * famiglia.
 *
 * @covers USAGE-07
 */
import { describe, expect, test } from 'bun:test';
import { contextWindowFor, formatContextWindow } from './context-window';
import { DEFAULT_CONTEXT_WINDOW } from './context-thresholds';

describe('formatContextWindow', () => {
  test('il milione si legge 1M, non 1000K', () => {
    expect(formatContextWindow(1_000_000)).toBe('1M');
  });

  test("gli 'quasi un milione' dei provider sono un milione per chi legge", () => {
    // 1_047_576 (gpt-4.1) e 1_048_576 (gemini) differiscono dal milione tondo
    // del 5‰: mostrarli come `1.05M` sarebbe precisione senza informazione, e
    // due modelli con la stessa finestra apparirebbero diversi.
    expect(formatContextWindow(1_047_576)).toBe('1M');
    expect(formatContextWindow(1_048_576)).toBe('1M');
  });

  test('sopra il milione la decimale resta se cambia la lettura', () => {
    expect(formatContextWindow(1_500_000)).toBe('1.5M');
    expect(formatContextWindow(2_000_000)).toBe('2M');
  });

  test('sotto il milione si legge in K, arrotondato', () => {
    expect(formatContextWindow(200_000)).toBe('200K');
    expect(formatContextWindow(400_000)).toBe('400K');
    expect(formatContextWindow(128_000)).toBe('128K');
  });

  test('un numero che non è un numero non stampa NaN', () => {
    // Il badge del picker riceve `window.tokens` senza filtrarlo: se qui
    // uscisse `NaNK` finirebbe tale e quale sotto il nome del modello.
    expect(formatContextWindow(Number.NaN)).toBe('?');
    expect(formatContextWindow(0)).toBe('?');
    expect(formatContextWindow(-1)).toBe('?');
  });
});

describe('contextWindowFor — le due proprietà su cui si appoggia il picker', () => {
  test('un modello sconosciuto cade sul default e lo DICHIARA', () => {
    const w = contextWindowFor('modello-che-non-esiste-9');
    expect(w.tokens).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(w.known).toBe(false); // <- è questo che fa comparire la tilde
  });

  test('il suffisso [1m] vince sulla famiglia', () => {
    // `claude-sonnet-4` è in tabella a 200k: la variante a finestra lunga deve
    // leggere un milione, o il picker mostrerebbe 200K su una riga da 1M.
    expect(contextWindowFor('claude-sonnet-4')).toEqual({ tokens: 200_000, known: true });
    expect(contextWindowFor('claude-sonnet-4[1m]')).toEqual({ tokens: 1_000_000, known: true });
  });

  test('ogni modello ha un numero: nessuna riga resta muta', () => {
    // Il punto della modifica: prima il badge compariva solo sulle varianti
    // `[1m]`, quindi l'assenza non distingueva «non è lungo» da «non lo
    // diciamo». Adesso ogni id produce un numero, sempre.
    for (const id of ['claude-opus-5', 'claude-haiku-4-5', 'gpt-5-codex', 'o3', 'boh-mai-visto']) {
      expect(formatContextWindow(contextWindowFor(id).tokens)).toMatch(/^\d+(\.\d)?[KM]$/);
    }
  });
});
