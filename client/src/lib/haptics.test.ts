import { describe, test, expect, afterEach } from 'bun:test';
import { haptic } from './haptics';

type StubNavigator = { vibrate?: unknown };
const g = globalThis as unknown as { navigator: StubNavigator | undefined };
const realNavigator = g.navigator;

afterEach(() => { g.navigator = realNavigator; });

describe('haptic() — l’unica porta per la micro-vibrazione', () => {
  test('dove la Vibration API c’è, la pulsazione parte davvero', () => {
    const calls: unknown[] = [];
    g.navigator = { vibrate: (p: unknown) => { calls.push(p); return true; } };

    expect(haptic('medium')).toBe(true);
    expect(calls).toEqual([20]);
  });

  test('i tre livelli sono tre durate diverse, e il default è il più leggero', () => {
    const calls: unknown[] = [];
    g.navigator = { vibrate: (p: unknown) => { calls.push(p); return true; } };

    haptic('light');
    haptic('medium');
    haptic('heavy');
    haptic();

    // Se un giorno i tre livelli collassassero sullo stesso numero, «medium» e
    // «heavy» sarebbero decorazione: la differenza è il contratto.
    expect(calls).toEqual([10, 20, 30, 10]);
  });

  test('su iPhone la Vibration API non esiste: `false`, e nessuna eccezione', () => {
    // Il caso REALE del dispositivo di casa. caniuse: «Safari on iOS 3.2 – 26.5:
    // Not supported». Qui si pretende che il no-op sia SILENZIOSO — vedi il test
    // successivo per il perché conta.
    g.navigator = {};

    expect(haptic('medium')).toBe(false);
  });

  test('una `vibrate` dichiarata ma non funzione non deve LANCIARE', () => {
    // `'vibrate' in navigator` sarebbe vero qui, e la chiamata tirerebbe un
    // TypeError. Non è pignoleria: l’unico chiamante è il timer di
    // `useLongPress`, che fa `haptic('medium')` sulla riga PRIMA di aprire il
    // menu contestuale — un throw qui e il «tieni premuto» smette di aprire
    // qualsiasi menu su tutto il touch.
    g.navigator = { vibrate: undefined };
    expect(() => haptic('medium')).not.toThrow();
    expect(haptic('medium')).toBe(false);

    g.navigator = { vibrate: null };
    expect(() => haptic('medium')).not.toThrow();
    expect(haptic('medium')).toBe(false);
  });

  test('se la piattaforma LANCIA, l’eccezione non risale al gesto', () => {
    // Stessa posta in gioco del test sopra, altro modo di perderla: una
    // `vibrate` che c’è, è una funzione, e tira lo stesso (permessi, iframe
    // senza user activation, WebView di terze parti).
    g.navigator = { vibrate: () => { throw new Error('NotAllowedError'); } };

    expect(() => haptic('medium')).not.toThrow();
    expect(haptic('medium')).toBe(false);
  });

  test('senza `navigator` (SSR / worker) non esplode', () => {
    g.navigator = undefined;

    expect(() => haptic()).not.toThrow();
    expect(haptic()).toBe(false);
  });
});
