/**
 * Il punto di questi test non e' il valore restituito: e' QUANTE VOLTE si
 * costruisce un `MediaQueryList`.
 *
 * Il difetto misurato era +741 oggetti vivi in 104 minuti a schermo fermo, e
 * nasceva da una `matchMedia` chiamata dentro un effetto senza array di
 * dipendenze — cioe' a ogni render. Un test sul solo `.matches` sarebbe restato
 * verde con il difetto dentro: e' per questo che il primo caso qui sotto conta
 * le chiamate e non le risposte.
  * @covers MOTION-02
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { prefersReducedMotion, resetReducedMotionCache } from './reducedMotion';

type FakeWindow = { matchMedia?: unknown };
const g = globalThis as unknown as { window: FakeWindow | undefined };
const realWindow = g.window;

afterEach(() => {
  g.window = realWindow;
  resetReducedMotionCache();
});

describe('prefersReducedMotion', () => {
  test('costruisce UN SOLO MediaQueryList anche su mille chiamate', () => {
    let costruiti = 0;
    g.window = {
      matchMedia: () => {
        costruiti += 1;
        return { matches: false };
      },
    };
    resetReducedMotionCache();

    for (let i = 0; i < 1000; i += 1) prefersReducedMotion();

    // Questo numero E' la correzione. Prima era mille.
    expect(costruiti).toBe(1);
  });

  test('legge la preferenza CORRENTE, non quella del momento in cui si e memorizzata', () => {
    // Il `MediaQueryList` resta vivo e il browser gli aggiorna `.matches` da
    // solo: tenersi l'oggetto non congela la risposta. Se lo congelasse, questa
    // ottimizzazione sarebbe un difetto peggiore di quello che corregge.
    const vivo = { matches: false };
    g.window = { matchMedia: () => vivo };
    resetReducedMotionCache();

    expect(prefersReducedMotion()).toBe(false);
    vivo.matches = true;
    expect(prefersReducedMotion()).toBe(true);
  });

  test('chiede la query giusta', () => {
    let chiesta = '';
    g.window = {
      matchMedia: (q: string) => {
        chiesta = q;
        return { matches: true };
      },
    };
    resetReducedMotionCache();

    expect(prefersReducedMotion()).toBe(true);
    expect(chiesta).toBe('(prefers-reduced-motion: reduce)');
  });

  test('senza matchMedia risponde false e NON ritenta a ogni chiamata', () => {
    // "Non ancora chiesto" e "ambiente senza matchMedia" sono due stati
    // diversi apposta: se collassassero, ogni chiamata ritenterebbe.
    g.window = {};
    resetReducedMotionCache();

    expect(prefersReducedMotion()).toBe(false);
    expect(prefersReducedMotion()).toBe(false);
  });

  test('fuori dal browser risponde false: chi non ha un sistema operativo non ha una preferenza', () => {
    g.window = undefined;
    resetReducedMotionCache();

    expect(prefersReducedMotion()).toBe(false);
  });
});
